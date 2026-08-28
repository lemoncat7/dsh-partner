import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Companion, ChannelSession } from './domain.js'
import { PartnerStore } from './store.js'
import type { PartnerMemoryStore } from './memory-store.js'
import type { MemoryReflectionService } from './memory-reflection.js'
import { concernObservationPrompt } from './autonomy.js'
import type { ConcernObservation, ConcernObservationCandidate, PartnerConcern } from './concern-domain.js'
import type { PartnerConcernStore } from './concern-store.js'
import type { PartnerInboundMessage, PartnerOutboundAttachment, PartnerReply } from './channel-message.js'
import { PARTNER_MEDIA_MAX_BYTES, safeMediaName } from './channel-message.js'
import { listConcernFileSources, type ConcernSource } from './concern-sources.js'

type RuntimeContext = Context & {
  agents: Context['agents']
  agentDefaultModel: AgentDefaultModelConfig
  agentPresets: AgentPresets
  workspaceRegistry: WorkspaceRegistry
  tools: ToolRuntime
}

interface KnowledgeTrackingService {
  record(agent: Agent, input: {
    id: string; subject: string; event: string; evidence: string; source: string; reference?: string; at: number
  }, signal?: AbortSignal): Promise<{ storage: 'knowledge' | 'local'; outcome: string; knowledgeBaseId?: string }>
  list?(agent: { session: { id: string; header: { cwd?: string }; events: readonly [] } }, query?: string, limit?: number, signal?: AbortSignal): Promise<ConcernSource[]>
}

const HEARTBEAT_TIMEOUT_MS = 115_000
const HEARTBEAT_DISCOVERY_BUDGET_MS = 72_000
const HEARTBEAT_TOOL_TIMEOUT_MS = 18_000
const HEARTBEAT_WEB_TOOL_TIMEOUT_MS = 30_000
const HEARTBEAT_BASE_TOOL_CALL_LIMIT = 8
const HEARTBEAT_MAX_TOOL_CALL_LIMIT = 20
const HEARTBEAT_TOOL_RESULT_LIMIT = 5_000
const HEARTBEAT_KNOWLEDGE_RESULT_LIMIT = 8_000
const HEARTBEAT_WEB_FETCH_RESULT_LIMIT = 40_000
const HEARTBEAT_WEB_SOURCE_RESULT_LIMIT = 125_000
const HEARTBEAT_AUDIT_INPUT_LIMIT = 320
const HEARTBEAT_AUDIT_OUTPUT_LIMIT = 520
const HEARTBEAT_READ_ONLY_TOOLS = new Set([
  'knowledge_base_search',
  'knowledge_search',
  'knowledge_read',
  'web_search',
  'web_fetch',
  'web_source',
  'glob',
  'grep',
  'read',
])
const HEARTBEAT_FILE_UPDATE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const HEARTBEAT_TOOLS = new Set([...HEARTBEAT_READ_ONLY_TOOLS, ...HEARTBEAT_FILE_UPDATE_TOOLS])

export interface HeartbeatToolTrace {
  name: string
  input: string
  output: string
  startedAt: number
  completedAt: number
  status: 'completed' | 'failed'
}

export interface HeartbeatExecution {
  concerns: PartnerConcern[]
  candidates: ConcernObservationCandidate[]
  observations?: ConcernObservation[]
  startedAt: number
  completedAt: number
  output?: string
  error?: string
  tools: HeartbeatToolTrace[]
}

export type HeartbeatOutcome = 'notified' | 'quiet' | 'failed'

export class PartnerAgentRuntime {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly heartbeatQueues = new Map<string, Promise<HeartbeatExecution>>()
  private readonly steeringQueues = new Map<string, Promise<void>>()
  private readonly workspaces = new Map<string, Promise<Workspace>>()

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly store: PartnerStore,
    private readonly defaultCwd: string,
    private readonly memory?: PartnerMemoryStore,
    private readonly reflection?: MemoryReflectionService,
    private readonly concerns?: PartnerConcernStore,
  ) {}

  async reply(companion: Companion, channelId: string, userId: string, message: PartnerInboundMessage): Promise<PartnerReply> {
    const key = `${channelId}:${userId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    let output: PartnerReply = { text: '', attachments: [] }
    const current = previous.catch(() => {}).then(async () => { output = await this.drive(companion, channelId, userId, message) })
    this.queues.set(key, current)
    try { await current; return output } finally { if (this.queues.get(key) === current) this.queues.delete(key) }
  }

  async steer(companion: Companion, channelId: string, userId: string, message: PartnerInboundMessage): Promise<boolean> {
    const key = `${channelId}:${userId}`
    const previous = this.steeringQueues.get(key) ?? Promise.resolve()
    let accepted = false
    const current = previous.catch(() => {}).then(async () => { accepted = await this.deliverSteering(companion, channelId, userId, message) })
    this.steeringQueues.set(key, current)
    try { await current; return accepted } finally { if (this.steeringQueues.get(key) === current) this.steeringQueues.delete(key) }
  }

  private async deliverSteering(companion: Companion, channelId: string, userId: string, message: PartnerInboundMessage): Promise<boolean> {
    const route = this.store.snapshot().sessions.find(item => item.channelId === channelId && item.userId === userId && item.companionId === companion.id)
    if (route === undefined) return false
    const agent = this.handles.get(route.sessionId)?.agent ?? this.ctx.agents.get(route.sessionId as SessionId)
    if (agent === undefined || agent.status !== 'running') return false
    const inbound = await this.persistInbound(route, message)
    const recalled = await this.memory?.recall(companion.id, memoryScope(channelId, userId), inbound.query, 12).catch(() => [])
    if (recalled && recalled.length > 0) agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderMemory(recalled) }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴为插话召回了相关长期记忆' },
    }))
    const deferred = await this.concerns?.deferred(companion.id, memoryScope(channelId, userId), inbound.query, 2).catch(() => [])
    if (deferred && deferred.length > 0) {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: renderDeferredMentions(deferred) }],
        source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴想起了与当前消息相关的挂念' },
      }))
      await this.concerns?.markMentioned(companion.id, deferred.map(item => item.id)).catch(() => {})
    }
    agent.steer(createUserMessage({ content: inbound.content, source: { kind: 'user' } }))
    return true
  }

  async prepareSession(routeId: string): Promise<ChannelSession> {
    const route = this.store.snapshot().sessions.find(item => item.id === routeId)
    if (route === undefined) throw new Error('伙伴会话不存在')
    const companion = this.store.snapshot().companions.find(item => item.id === route.companionId)
    if (companion === undefined) throw new Error('伙伴身份不存在')
    await this.ensureAgent(companion, route)
    return route
  }

  isArchived(route: ChannelSession): boolean {
    return this.ctx.workspaceRegistry.archivedSessionIds.includes(route.sessionId as SessionId)
  }

  async renewSession(routeId: string): Promise<ChannelSession> {
    const previous = this.store.snapshot().sessions.find(item => item.id === routeId)
    if (previous === undefined) throw new Error('伙伴会话不存在')
    if (!this.isArchived(previous)) return previous
    const next = renewedSession(previous)
    await this.store.update(state => {
      state.sessions = state.sessions.map(item => item.id === routeId ? next : item)
    })
    return next
  }

  async heartbeat(companion: Companion, route: ChannelSession, concerns: PartnerConcern[]): Promise<HeartbeatExecution> {
    const key = `${route.channelId}:${route.userId}`
    const queued = this.heartbeatQueues.get(key)
    if (queued !== undefined) return queued
    const current = this.runHeartbeatWhenIdle(key, companion, route, concerns)
    this.heartbeatQueues.set(key, current)
    try { return await current } finally { if (this.heartbeatQueues.get(key) === current) this.heartbeatQueues.delete(key) }
  }

  async persistKnowledgeObservations(
    companion: Companion,
    route: ChannelSession,
    concerns: PartnerConcern[],
    observations: ConcernObservation[],
  ): Promise<void> {
    const service = this.ctx.get('dshKnowledgeTracking') as KnowledgeTrackingService | undefined
    if (service === undefined || observations.length === 0) return
    const agent = await this.ensureAgent(companion, route)
    const byId = new Map(concerns.map(item => [item.id, item]))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('知识库观察记录超时')), 30_000)
    timeout.unref?.()
    try {
      for (const observation of observations) {
        if (observation.decision === 'drop') continue
        const concern = byId.get(observation.concernId)
        if (concern === undefined) continue
        const references = concern.resources.filter(item => item.kind === 'knowledge').map(item => item.locator).slice(0, 4)
        if (references.length === 0 && concern.watchKind !== 'knowledge') continue
        for (const reference of references.length > 0 ? references : [undefined]) {
          await service.record(agent, {
            id: observation.id,
            subject: concern.subject,
            event: observation.event,
            evidence: observation.evidence,
            source: observation.source,
            ...(reference === undefined ? {} : { reference }),
            at: observation.createdAt,
          }, controller.signal).catch(error => {
            this.ctx.logger.warn(`dsh-partner: knowledge observation fell back to local storage: ${errorMessage(error)}`)
          })
        }
      }
    } finally { clearTimeout(timeout) }
  }

  async concernSources(companion: Companion, query = ''): Promise<ConcernSource[]> {
    const routes = this.store.snapshot().sessions
      .filter(item => item.companionId === companion.id)
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
    const root = routes[0]?.cwd ?? partnerCwd(this.defaultCwd, companion.id)
    const files = await listConcernFileSources(root, query, 24)
    const service = this.ctx.get('dshKnowledgeTracking') as KnowledgeTrackingService | undefined
    if (service?.list === undefined || routes[0] === undefined) return files
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('知识文档候选查询超时')), 8_000)
    timeout.unref?.()
    try {
      const route = routes[0]
      const knowledge = await service.list({ session: { id: route.sessionId, header: { cwd: root }, events: [] } }, query, 16, controller.signal).catch(error => {
        this.ctx.logger.warn(`dsh-partner: knowledge concern sources unavailable: ${errorMessage(error)}`)
        return []
      })
      return [...files, ...knowledge].slice(0, 40)
    } finally { clearTimeout(timeout) }
  }

  private async runHeartbeatWhenIdle(key: string, companion: Companion, route: ChannelSession, concerns: PartnerConcern[]): Promise<HeartbeatExecution> {
    for (;;) {
      await this.queues.get(key)?.catch(() => {})
      const conversation = await this.ensureAgent(companion, route)
      if (conversation.status !== 'idle') await conversation.whenIdle()
      const stableSeq = conversation.session.seq
      await delay(2_000)
      if (this.queues.has(key)) continue
      if (conversation.status !== 'idle' || conversation.session.seq !== stableSeq) continue
      return this.driveScopedHeartbeat(conversation, companion, concerns)
    }
  }

  async observeSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const route = this.store.snapshot().sessions.find(item => item.sessionId === session.id)
    if (route === undefined) return
    const companion = this.store.snapshot().companions.find(item => item.id === route.companionId)
    if (companion === undefined) return
    const events = completedTurnEvents(session.events, event)
    const prompt = events.find(item => item.type === 'user/message' && item.data.source.kind === 'user')
    const replies = events.filter(item => item.type === 'assistant/message' && !item.data.interrupted)
    const userText = prompt?.type === 'user/message' ? textContent(prompt.data.content) : ''
    const assistantText = replies.flatMap(item => item.type === 'assistant/message' ? [textContent(item.data.message.content)] : []).filter(Boolean).join('\n\n')
    if (!userText || !assistantText) return
    const scopeId = memoryScope(route.channelId, route.userId)
    const concernDirective = await this.concerns?.applyUserDirective(companion.id, scopeId, userText, event.time)
    if (!companion.automation.memory.enabled || this.reflection === undefined) return
    await this.reflection.reflect(companion, {
      id: `turn-${randomUUID()}`, companionId: companion.id, scopeId,
      sessionId: session.id, at: event.time, user: userText, assistant: assistantText,
      ...(concernDirective === undefined ? {} : { concernDirective }),
    })
    await this.store.update(state => {
      const target = state.sessions.find(item => item.id === route.id)
      if (target) target.lastMessageAt = Date.now()
    })
  }

  private async driveScopedHeartbeat(conversation: Agent, companion: Companion, concerns: PartnerConcern[]): Promise<HeartbeatExecution> {
    const scope = await createHeartbeatScope(this.ctx, conversation, concerns)
    try { return await this.driveEphemeralHeartbeat(scope.agent, companion, concerns) }
    finally { await scope.dispose() }
  }

  private async driveEphemeralHeartbeat(agent: Agent, companion: Companion, concerns: PartnerConcern[]): Promise<HeartbeatExecution> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('伙伴心跳超过安全时限')), HEARTBEAT_TIMEOUT_MS)
    timeout.unref?.()
    try {
      const execution = await runHeartbeatInference(this.ctx, agent, companion, concerns, controller.signal)
      return controller.signal.aborted
        ? { ...execution, error: '伙伴心跳超过安全时限，已收束并终止' }
        : execution
    } catch (error) {
      const now = Date.now()
      return {
        concerns,
        candidates: [],
        startedAt: now,
        completedAt: now,
        tools: [],
        error: controller.signal.aborted ? '伙伴心跳超过安全时限，已收束并终止' : errorMessage(error),
      }
    } finally { clearTimeout(timeout) }
  }

  async recordHeartbeatActivity(
    companion: Companion,
    route: ChannelSession,
    execution: HeartbeatExecution,
    outcome: HeartbeatOutcome,
    deliveryError?: string,
  ): Promise<void> {
    const conversation = await this.ensureAgent(companion, route)
    if (conversation.status !== 'idle') await conversation.whenIdle()
    conversation.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: renderHeartbeatActivity(execution, outcome, deliveryError) }],
      source: {
        kind: 'plugin',
        plugin: '@lemoncat7/dsh-partner',
        form: 'notice',
        summary: '伙伴正在进行低打扰心跳检查',
      },
    }), { surfaceOp: 'append' })
  }

  async resetCompanion(companionId: string): Promise<void> {
    await this.releaseCompanion(companionId)
    await this.store.update(state => { state.sessions = state.sessions.filter(item => item.companionId !== companionId) })
  }

  async reloadCompanion(companionId: string): Promise<void> {
    await this.releaseCompanion(companionId)
  }

  private async releaseCompanion(companionId: string): Promise<void> {
    const sessions = this.store.snapshot().sessions.filter(item => item.companionId === companionId)
    await Promise.all(sessions.map(async item => {
      const handle = this.handles.get(item.sessionId)
      this.handles.delete(item.sessionId)
      await handle?.dispose().catch(() => {})
    }))
  }

  async resetChannel(channelId: string): Promise<void> {
    const sessions = this.store.snapshot().sessions.filter(item => item.channelId === channelId)
    await Promise.all(sessions.map(async item => {
      const handle = this.handles.get(item.sessionId)
      this.handles.delete(item.sessionId)
      await handle?.dispose().catch(() => {})
    }))
    await this.store.update(state => { state.sessions = state.sessions.filter(item => item.channelId !== channelId) })
  }

  async close(): Promise<void> {
    await Promise.all([...this.handles.values()].map(handle => handle.dispose().catch(() => {})))
    this.handles.clear()
    this.heartbeatQueues.clear()
    this.steeringQueues.clear()
  }

  private async drive(companion: Companion, channelId: string, userId: string, message: PartnerInboundMessage): Promise<PartnerReply> {
    const session = await this.ensureSession(companion, channelId, userId)
    const agent = await this.ensureAgent(companion, session)
    if (agent.status !== 'idle') await agent.whenIdle()
    const inbound = await this.persistInbound(session, message)
    const recalled = await this.memory?.recall(companion.id, memoryScope(channelId, userId), inbound.query, 12).catch(() => [])
    if (recalled && recalled.length > 0) agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderMemory(recalled) }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴回忆了与当前消息相关的长期记忆' },
    }))
    const deferred = await this.concerns?.deferred(companion.id, memoryScope(channelId, userId), inbound.query, 2).catch(() => [])
    if (deferred && deferred.length > 0) agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderDeferredMentions(deferred) }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴想起了与当前消息相关的挂念' },
    }))
    const startSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: inbound.content,
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const response = extractAssistantText(agent, startSeq)
    await this.store.update(state => {
      const target = state.sessions.find(item => item.id === session.id)
      if (target) target.lastMessageAt = Date.now()
    })
    if (!response) throw new Error('伙伴没有生成可发送的文本回复')
    if (deferred && deferred.length > 0) await this.concerns?.markMentioned(companion.id, deferred.map(item => item.id)).catch(() => {})
    return { text: response, attachments: await extractOutboundAttachments(response, session.cwd ?? this.defaultCwd) }
  }

  private async persistInbound(session: ChannelSession, message: PartnerInboundMessage): Promise<{ content: ContentBlock[]; query: string }> {
    const cwd = session.cwd ?? this.defaultCwd
    const directory = join(cwd, 'inbound')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const content: ContentBlock[] = []
    const notes: string[] = []
    for (const attachment of message.attachments) {
      if (attachment.data.byteLength > PARTNER_MEDIA_MAX_BYTES) throw new Error('微信附件超过 64 MB 限制')
      const name = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeMediaName(attachment.name)}`
      const path = join(directory, name)
      await writeFile(path, attachment.data, { flag: 'wx', mode: 0o600 })
      notes.push(`微信${attachment.kind === 'image' ? '图片' : '文档'}已保存：${path}`)
      if (attachment.kind === 'image') {
        const mediaType = attachment.mediaType as ImageMediaType
        const ref = await this.ctx.attachments.saveImage({ data: attachment.data, mediaType, name: attachment.name })
        content.push({ type: 'image', attachment: ref })
      }
    }
    const visibleText = [message.text.trim(), ...notes].filter(Boolean).join('\n\n')
    if (visibleText) content.unshift({ type: 'text', text: visibleText })
    if (content.length === 0) content.push({ type: 'text', text: '[微信附件消息]' })
    return { content, query: [message.text, ...message.attachments.map(item => item.name)].filter(Boolean).join(' ') }
  }

  private async ensureSession(companion: Companion, channelId: string, userId: string): Promise<ChannelSession> {
    const existing = this.store.snapshot().sessions.find(item => item.channelId === channelId && item.userId === userId)
    if (existing !== undefined && canReuseSession(existing, companion.id, this.ctx.workspaceRegistry.archivedSessionIds)) return existing
    const now = Date.now()
    const session: ChannelSession = {
      id: `route-${randomUUID()}`,
      channelId,
      userId,
      companionId: companion.id,
      sessionId: `session-${randomUUID()}`,
      cwd: partnerCwd(this.defaultCwd, companion.id),
      lastMessageAt: now,
    }
    await this.store.update(state => {
      state.sessions = state.sessions.filter(item => !(item.channelId === channelId && item.userId === userId))
      state.sessions.push(session)
    })
    return session
  }

  private async ensureAgent(companion: Companion, route: ChannelSession): Promise<Agent> {
    const cwd = route.cwd ?? this.defaultCwd
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const held = this.handles.get(route.sessionId)
    if (held !== undefined) {
      await this.attachSession(companion, route)
      return held.agent
    }
    const live = this.ctx.agents.get(route.sessionId as SessionId)
    if (live !== undefined) {
      await this.attachSession(companion, route)
      return live
    }
    const options = resolveAgentOptions(this.ctx.agentDefaultModel, companion)
    const setup = async (agentCtx: Context): Promise<void> => {
      const presets = agentCtx.get('agentPresets') as AgentPresets | undefined
      if (presets === undefined) throw new Error('伙伴会话缺少 Agent Presets 服务')
      await presets.mount(agentCtx, companion.presetId)
      const memory = await this.memory?.recall(companion.id, memoryScope(route.channelId, route.userId), '', 12).catch(() => [])
      agentCtx.systemPrompt.section({
        name: 'partner-identity',
        order: -10,
        text: renderPersona(companion),
      })
      agentCtx.systemPrompt.section({
        name: 'partner-tool-routing',
        order: -9,
        text: renderToolProtocol(),
      })
      if (memory && memory.length > 0) agentCtx.systemPrompt.section({
        name: 'partner-long-term-memory',
        order: -8,
        text: renderMemory(memory),
      })
    }
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: route.sessionId as SessionId,
        agentOptions: options,
        setup,
      })
    } catch {
      handle = await this.ctx.agents.create({
        sessionId: route.sessionId as SessionId,
        meta: {
          cwd,
          ...(companion.presetId ? { agentPreset: companion.presetId } : {}),
        },
        agentOptions: options,
        setup,
      })
    }
    this.handles.set(route.sessionId, handle)
    await this.attachSession(companion, route)
    return handle.agent
  }

  private async attachSession(companion: Companion, route: ChannelSession): Promise<void> {
    const cwd = route.cwd ?? this.defaultCwd
    let workspace = this.workspaces.get(cwd)
    if (workspace === undefined) {
      workspace = this.ctx.workspaceRegistry.create(cwd, route.cwd === undefined ? '伙伴' : `伙伴 · ${companion.name}`)
      this.workspaces.set(cwd, workspace)
    }
    await (await workspace).attachSession(route.sessionId as SessionId)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export async function extractOutboundAttachments(text: string, cwd: string): Promise<PartnerOutboundAttachment[]> {
  const candidates = new Set<string>()
  for (const match of text.matchAll(/\[[^\]]*\]\((?:<)?(file:\/\/)?([^)>]+)(?:>)?\)/g)) {
    const value = decodeURIComponent(match[2] ?? '').trim()
    if (value) candidates.add(value)
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1]?.trim()
    if (value && mediaTypeFor(value)) candidates.add(value)
  }
  for (const line of text.split('\n').map(item => item.trim())) {
    const value = line.replace(/^`|`$/g, '')
    if (value.startsWith('/') && !value.includes(' ')) candidates.add(value)
  }
  const root = await realpath(cwd)
  const result: PartnerOutboundAttachment[] = []
  const included = new Set<string>()
  for (const candidate of candidates) {
    if (result.length >= 8) break
    const target = resolve(root, candidate)
    let actual: string
    try { actual = await realpath(target) } catch { continue }
    if (included.has(actual)) continue
    const rel = relative(root, actual)
    if (rel.startsWith('..') || rel === '..' || resolve(root, rel) !== actual) continue
    const info = await stat(actual)
    if (!info.isFile() || info.size > PARTNER_MEDIA_MAX_BYTES) continue
    const mediaType = mediaTypeFor(actual)
    if (!mediaType) continue
    included.add(actual)
    result.push({ path: actual, name: basename(actual), mediaType, kind: mediaType.startsWith('image/') ? 'image' : 'file' })
  }
  return result
}

function mediaTypeFor(path: string): string | undefined {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  } as Record<string, string>)[extname(path).toLowerCase()]
}

export function completedTurnEvents(events: readonly SessionEvent[], end: Extract<SessionEvent, { type: 'turn/end' }>): readonly SessionEvent[] {
  let startSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]
    if (item === undefined || item.seq >= end.seq || item.type !== 'turn/start') continue
    if (item.data.turn === end.data.turn) {
      startSeq = item.seq
      break
    }
  }
  if (startSeq === undefined) return []
  return events.filter(item => item.seq > startSeq && item.seq < end.seq)
}

export function memoryScope(channelId: string, userId: string): string { return `${channelId}:${userId}` }

function renderMemory(entries: NonNullable<Awaited<ReturnType<PartnerMemoryStore['recall']>>>): string {
  return [
    '以下是系统按当前话题召回的结构化长期记忆。仅在相关时使用；不得扩写成记忆中没有的事实。',
    ...entries.map(entry => `- [${entry.kind}｜置信度 ${entry.confidence.toFixed(2)}] ${entry.subject}：${entry.content}`),
  ].join('\n')
}

function renderDeferredMentions(entries: ConcernObservation[]): string {
  return [
    '伙伴之前发现了与用户当前消息相关的新变化。若自然且确实有帮助，可以在本次回答末尾顺手提一句；不要抢占当前问题，也不要声称刚刚搜索。',
    ...entries.map(item => `- ${item.event}${item.evidence ? `（依据：${item.evidence}）` : ''}`),
  ].join('\n')
}

export function resolveAgentOptions(defaultModel: AgentDefaultModelConfig, companion: Companion) {
  return {
    ...defaultModel.currentSelection(),
    ...(companion.provider ? { provider: companion.provider } : {}),
    ...(companion.model ? { model: companion.model } : {}),
  }
}

export function canReuseSession(route: ChannelSession, companionId: string, archivedSessionIds: readonly SessionId[]): boolean {
  return route.companionId === companionId && !archivedSessionIds.includes(route.sessionId as SessionId)
}

export function renewedSession(previous: ChannelSession, now = Date.now()): ChannelSession {
  return {
    ...previous,
    id: `route-${randomUUID()}`,
    sessionId: `session-${randomUUID()}`,
    lastMessageAt: now,
  }
}

export function partnerCwd(root: string, companionId: string): string {
  return join(root, 'partners', companionId)
}

async function createHeartbeatScope(ctx: RuntimeContext, conversation: Agent, concerns: PartnerConcern[]): Promise<{ agent: Agent; dispose(): Promise<void> }> {
  const parent = scopeOf(conversation.ctx)
  if (parent === undefined) throw new Error('伙伴心跳无法解析当前 Agent 作用域')
  const availableTools = [...HEARTBEAT_TOOLS].filter(name => ctx.tools.get(name, conversation) !== undefined)
  const policy = heartbeatToolPolicy(concerns, availableTools)
  const allowedTools = [...policy.allowed]
  if (allowedTools.length === 0) throw new Error('伙伴心跳没有可用的只读发现工具')
  const cwd = conversation.session.header.cwd
  if (!cwd) throw new Error('伙伴心跳缺少当前伙伴工作目录')
  const fileAccess = await resolveHeartbeatFileAccess(cwd, concerns)
  const agent = {} as Agent
  const scope = createScope(ctx, agent, { parent })
  const agentCtx = scope.ctx.extend({ agent })
  Object.assign(agent, {
    id: conversation.id,
    options: conversation.options,
    session: conversation.session,
    inbox: conversation.inbox,
    status: 'idle',
    ctx: agentCtx,
    cancel: () => {},
    whenIdle: async () => {},
    runMaintenance: async <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    send: () => { throw new Error('心跳作用域不接受会话消息') },
    followup: () => { throw new Error('心跳作用域不接受会话消息') },
    steer: () => { throw new Error('心跳作用域不接受会话消息') },
    inject: () => { throw new Error('心跳作用域不接受会话消息') },
  } satisfies Partial<Agent>)
  agentCtx.tools.presentAs('native')
  agentCtx.tools.restrict({ allow: allowedTools })
  agentCtx.tools.guard(exec => {
    if (!policy.allowed.has(exec.name)) return `当前挂念的来源策略不允许调用 ${exec.name}`
    return heartbeatToolDenial(exec.name, exec.arguments, fileAccess)
  })
  return { agent, dispose: () => scope.dispose() }
}

interface HeartbeatToolPolicy {
  allowed: Set<string>
}

export function heartbeatToolPolicy(concerns: PartnerConcern[], available: Iterable<string>): HeartbeatToolPolicy {
  const installed = new Set(available)
  const hasLinkedFile = concerns.some(item => item.resources?.some(resource => resource.kind === 'file') === true)
  return {
    allowed: new Set([...installed].filter(name => HEARTBEAT_READ_ONLY_TOOLS.has(name) || (hasLinkedFile && HEARTBEAT_FILE_UPDATE_TOOLS.has(name)))),
  }
}

async function runHeartbeatInference(
  ctx: RuntimeContext,
  agent: Agent,
  companion: Companion,
  concerns: PartnerConcern[],
  signal: AbortSignal,
): Promise<HeartbeatExecution> {
  const startedAt = Date.now()
  const traces: HeartbeatToolTrace[] = []
  const discoveryDeadline = startedAt + HEARTBEAT_DISCOVERY_BUDGET_MS
  const toolCallLimit = Math.min(HEARTBEAT_MAX_TOOL_CALL_LIMIT, Math.max(HEARTBEAT_BASE_TOOL_CALL_LIMIT, concerns.length * 2 + 2))
  try {
    const selection = resolveAgentOptions(ctx.agentDefaultModel, companion)
    if (!selection.provider || !selection.model) throw new Error('伙伴心跳没有可用的模型路由')
    const tools = ctx.tools.schemas(agent).filter(tool => HEARTBEAT_TOOLS.has(tool.name))
    if (tools.length === 0) throw new Error('伙伴心跳没有可用的只读发现工具')
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: concernObservationPrompt(concerns, agent.session.header.cwd) }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴观察挂念变化' },
    })]
    let toolCalls = 0
    for (let step = 0; step < 10; step += 1) {
      const discoveryOpen = Date.now() < discoveryDeadline && toolCalls < toolCallLimit
      const prepared = await ctx.llm.prepareCall(selection, signal)
      const assembler = new BlockAssembler()
      for await (const chunk of prepared.stream({
        ...prepared.config,
        messages,
        system: renderPersona(companion, 'heartbeat'),
        tools: discoveryOpen ? tools : [],
        signal,
      })) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(`伙伴心跳模型调用失败：${finish.failure.message}`)
      }
      const response = assembler.message({ kind: 'model', provider: prepared.config.provider, model: prepared.config.model })
      messages.push(response)
      const pending = response.content.filter((block): block is ToolCallBlock => block.type === 'tool-call')
      if (pending.length === 0) {
        const output = textContent(response.content)
        return {
          concerns,
          candidates: parseConcernObservations(output, new Set(concerns.map(item => item.id))),
          startedAt,
          completedAt: Date.now(),
          output,
          tools: traces,
        }
      }
      for (const call of pending) {
        toolCalls += 1
        const argumentsValue = boundHeartbeatToolArguments(call.name, parseHeartbeatToolArguments(call))
        const toolStartedAt = Date.now()
        const budgetExpired = Date.now() >= discoveryDeadline
        const result = toolCalls > toolCallLimit || budgetExpired
          ? { isError: true as const, content: [{ type: 'text' as const, text: budgetExpired
              ? '本轮发现阶段的时间预算已用完，请根据已有结果立即输出最终 Observation JSON。'
              : `本轮已达到 ${toolCallLimit} 次工具调用上限，请根据已有结果立即收束。` }] }
          : await executeHeartbeatTool(ctx, agent, call, argumentsValue, signal)
        const toolCompletedAt = Date.now()
        const visibleContent = heartbeatToolContent(call.name, result.content)
        traces.push({
          name: call.name,
          input: auditValue(argumentsValue, HEARTBEAT_AUDIT_INPUT_LIMIT),
          output: auditText(textContent(visibleContent) || '工具返回了非文本结果', HEARTBEAT_AUDIT_OUTPUT_LIMIT),
          startedAt: toolStartedAt,
          completedAt: toolCompletedAt,
          status: result.isError ? 'failed' : 'completed',
        })
        messages.push(createToolResultMessage({ callId: call.id, content: visibleContent, isError: result.isError }))
      }
    }
    throw new Error('伙伴心跳未能在有限步骤内收束')
  } catch (error) {
    return { concerns, candidates: [], startedAt, completedAt: Date.now(), tools: traces, error: errorMessage(error) }
  }
}

function parseConcernObservations(raw: string, allowedIds: Set<string>): ConcernObservationCandidate[] {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) throw new Error('伙伴心跳没有返回 Observation JSON')
  const parsed = JSON.parse(match[0]) as { observations?: unknown }
  if (!Array.isArray(parsed.observations)) throw new Error('伙伴心跳 Observation 格式无效')
  const seen = new Set<string>()
  return parsed.observations.flatMap(value => {
    if (!isRecord(value)) return []
    const concernId = typeof value.concernId === 'string' ? value.concernId : ''
    if (!allowedIds.has(concernId) || seen.has(concernId)) return []
    seen.add(concernId)
    const changed = value.changed === true
    return [{
      concernId,
      changed,
      event: changed && typeof value.event === 'string' ? value.event.trim().slice(0, 800) : '',
      evidence: typeof value.evidence === 'string' ? value.evidence.trim().slice(0, 2_000) : '',
      source: typeof value.source === 'string' ? value.source.trim().slice(0, 240) : '',
      relevance: boundedScore(value.relevance),
      confidence: boundedScore(value.confidence),
      actionability: boundedScore(value.actionability),
    }]
  })
}

function boundedScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : .5
}

function parseHeartbeatToolArguments(call: ToolCallBlock): unknown {
  try { return JSON.parse(call.arguments) }
  catch { return { __invalidArguments: call.arguments } }
}

interface HeartbeatFileAccess {
  root: string
  writable: Set<string>
}

async function resolveHeartbeatFileAccess(cwd: string, concerns: PartnerConcern[]): Promise<HeartbeatFileAccess> {
  const root = await realpath(cwd)
  const writable = new Set<string>()
  const locators = concerns.flatMap(item => item.resources ?? []).filter(item => item.kind === 'file').map(item => item.locator)
  for (const locator of new Set(locators)) {
    const lexical = resolve(root, locator)
    if (!pathInside(root, lexical) || isPartnerMemoryPath(relative(root, lexical))) continue
    try {
      const actual = await realpath(lexical)
      const info = await stat(actual)
      if (!info.isFile() || !pathInside(root, actual) || isPartnerMemoryPath(relative(root, actual))) continue
      writable.add(lexical)
      writable.add(actual)
    } catch { /* References may become stale; stale files remain read-only and cannot be recreated. */ }
  }
  return { root, writable }
}

export function heartbeatToolDenial(name: string, argumentsValue: unknown, access?: HeartbeatFileAccess): string | undefined {
  if (!isRecord(argumentsValue)) return undefined
  const isRead = ['glob', 'grep', 'read'].includes(name)
  const isUpdate = HEARTBEAT_FILE_UPDATE_TOOLS.has(name)
  if (!isRead && !isUpdate) return undefined
  const paths = [argumentsValue.path, argumentsValue.file_path].filter((value): value is string => typeof value === 'string')
  if (paths.some(isPartnerMemoryPath)) return '伙伴心跳不能访问长期记忆、挂念数据库、会话归档或其备份目录；请改查普通工作文件或其他安全来源。'
  if (access && paths.some(value => !pathInside(access.root, resolve(access.root, value)))) return '伙伴心跳只能访问当前伙伴工作目录内的文件。'
  if (!isUpdate) return undefined
  if (name === 'str_replace_editor' && argumentsValue.command === 'create') return '心跳只能更新已经关联且现存的 @文件，不能创建新文件。'
  const target = paths[0]
  if (paths.length !== 1 || target === undefined || !access || !access.writable.has(resolve(access.root, target))) {
    return '心跳只能更新当前挂念明确关联的现存 @文件，不能修改其他文件。'
  }
  return undefined
}

async function executeHeartbeatTool(
  ctx: RuntimeContext,
  agent: Agent,
  call: ToolCallBlock,
  argumentsValue: unknown,
  signal: AbortSignal,
): Promise<{ isError: boolean; content: ContentBlock[] }> {
  const timeoutMs = call.name === 'web_fetch' || call.name === 'web_source' ? HEARTBEAT_WEB_TOOL_TIMEOUT_MS : HEARTBEAT_TOOL_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const toolSignal = AbortSignal.any([signal, timeoutSignal])
  try {
    return await ctx.tools.execute({ callId: call.id, name: call.name, arguments: argumentsValue, agent, signal: toolSignal })
  } catch (error) {
    const message = timeoutSignal.aborted && !signal.aborted
      ? `工具 ${call.name} 超过 ${timeoutMs / 1_000} 秒，已跳过；请按既有规则判断来源不可用，或根据已有结果收束。`
      : `工具 ${call.name} 调用失败：${errorMessage(error)}`
    return { isError: true, content: [{ type: 'text', text: message }] }
  }
}

function pathInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function boundHeartbeatToolArguments(name: string, value: unknown): unknown {
  if (!isRecord(value)) return value
  const bounded = { ...value }
  if (name === 'knowledge_base_search' || name === 'knowledge_search') bounded.limit = boundedInteger(value.limit, 4)
  if (name === 'knowledge_read') bounded.maxChars = boundedInteger(value.maxChars, HEARTBEAT_KNOWLEDGE_RESULT_LIMIT)
  if (name === 'web_source') bounded.max_chars = boundedInteger(value.max_chars, 120_000)
  if (name === 'read') bounded.limit = boundedInteger(value.limit, 80)
  return bounded
}

function heartbeatToolContent(name: string, content: readonly ContentBlock[]): ContentBlock[] {
  let remaining = heartbeatToolResultLimit(name)
  const bounded: ContentBlock[] = []
  for (const block of content) {
    if (remaining <= 0) break
    if (block.type !== 'text') {
      bounded.push(block)
      continue
    }
    const sanitized = name === 'glob'
      ? block.text.split('\n').filter(line => !isPartnerMemoryPath(line.trim())).join('\n')
      : block.text
    const text = sanitized.length <= remaining ? sanitized : `${sanitized.slice(0, Math.max(0, remaining - 1))}…`
    if (text) bounded.push({ ...block, text })
    remaining -= text.length
  }
  if (bounded.length === 0 && name === 'glob') return [{ type: 'text', text: '未发现可供心跳检查的普通工作文件；伙伴记忆与会话归档已从结果中排除。' }]
  return bounded
}

function heartbeatToolResultLimit(name: string): number {
  if (name === 'knowledge_read') return HEARTBEAT_KNOWLEDGE_RESULT_LIMIT
  if (name === 'web_fetch') return HEARTBEAT_WEB_FETCH_RESULT_LIMIT
  if (name === 'web_source') return HEARTBEAT_WEB_SOURCE_RESULT_LIMIT
  return HEARTBEAT_TOOL_RESULT_LIMIT
}

function isPartnerMemoryPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '/')
  return /(?:^|\/)(?:memory(?:\/|-backup(?:-|\/)|$)|concerns(?:\/|$))/i.test(normalized)
}

function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function renderHeartbeatActivity(
  execution: HeartbeatExecution,
  outcome: HeartbeatOutcome,
  deliveryError?: string,
): string {
  const status = outcome === 'notified' ? '已通过微信提醒' : outcome === 'quiet' ? '无需主动提醒' : '执行失败'
  const lines = [
    `状态：${status}`,
    `本轮挂念：${execution.concerns.map(item => item.subject).join('；')}`,
    `用时：${formatDuration(execution.completedAt - execution.startedAt)}`,
    `工具：${execution.tools.length > 0 ? `${execution.tools.length} 次调用` : '未调用'}`,
  ]
  execution.tools.forEach((trace, index) => {
    lines.push(
      '',
      `${index + 1}. ${trace.name} · ${trace.status === 'completed' ? '完成' : '失败'} · ${formatDuration(trace.completedAt - trace.startedAt)}`,
      `输入：${trace.input}`,
      `结果：${trace.output}`,
    )
  })
  const changed = execution.observations ?? []
  const conclusion = execution.error || deliveryError
    ? `失败原因：${deliveryError ?? execution.error}`
    : changed.length > 0
      ? `新变化：\n${changed.map(item => `- ${item.event}（${decisionLabel(item.decision)} · ${Math.round(item.interruptScore * 100)}）`).join('\n')}`
      : '最终结论：本轮没有发现经过校验的新变化。'
  lines.push('', conclusion)
  return lines.join('\n')
}

function decisionLabel(value: ConcernObservation['decision']): string {
  return value === 'notify' ? '已提醒' : value === 'feed' ? '伙伴动态' : value === 'defer' ? '顺手一提' : value === 'remember' ? '静默记下' : '忽略'
}

function auditValue(value: unknown, limit: number): string {
  try { return auditText(JSON.stringify(value), limit) }
  catch { return auditText(String(value), limit) }
}

function auditText(value: string, limit: number): string {
  const text = value.trim().replace(/\n{3,}/g, '\n\n')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function renderPersona(companion: Companion, surface: 'conversation' | 'heartbeat' = 'conversation'): string {
  const capabilities = companion.capabilities.length > 0 ? companion.capabilities.join('、') : '由当前 Agent Preset 提供的基础能力'
  return [
    `你当前以长期工作伙伴「${companion.name}」的身份工作。`,
    `角色：${companion.role}`,
    companion.description ? `定位：${companion.description}` : '',
    companion.instructions ? `长期行为准则：\n${companion.instructions}` : '',
    `用户为此伙伴启用的能力范围：${capabilities}。能力标识不等于授权；只能调用当前会话实际提供且已经通过权限校验的工具。`,
    surface === 'heartbeat'
      ? '这是一轮独立的伙伴心跳，不是用户聊天的延续。只根据本轮真实可读信息行动，最终结果由渠道适配器决定是否发送。'
      : '这个会话由 DSH 网页与微信私聊渠道共同使用。保持同一上下文，不要假定每条消息都来自微信；渠道回传由适配器负责。回答兼顾网页与移动端阅读，执行外部操作前继续遵守工具自身的授权与审批边界。',
  ].filter(Boolean).join('\n\n')
}

export function renderToolProtocol(): string {
  return [
    'DSH 工具调用协议（必须遵守）：工具 SDK 中出现某项能力，不代表它可以作为顶层函数直接调用。',
    '先以当前请求真正暴露的顶层工具清单为准。若顶层只提供 `run_code`，则它是唯一允许直接调用的工具；`web_search`、知识库、SSH 等 SDK 能力必须放进 `run_code` 程序，通过生成的 `tools` SDK 按准确签名调用，例如 `await tools.web_search(...)`。绝不要直接发起名为 `web_search` 的顶层工具调用。',
    '`run_code` 的程序只返回完成当前任务所需的精简结果。需要顺序依赖时逐个 `await`，互不依赖的只读调用才可并行。',
    '若工具结果提示 “only `run_code` is callable directly”，说明路由方式错误；立即在同一轮改用 `run_code` 重试。只有规范重试也失败时，才向用户说明真正的失败原因。',
    '若当前请求原生暴露了目标工具，则可以直接调用该原生工具；不要臆造未出现在顶层清单或生成 SDK 中的工具。',
    '需要把生成的图片或文档交给用户时，最终回复必须用 Markdown 链接明确引用伙伴工作目录中的文件，例如 `[下载文件](/绝对路径/文件.pdf)`；不要只说“文件在这里”。渠道会在确认真实路径位于伙伴工作目录后发送附件。',
  ].join('\n')
}

function extractAssistantText(agent: Agent, fromSeq: number): string {
  const messages: string[] = []
  for (const event of agent.session.events) {
    if (event.seq < fromSeq || event.type !== 'assistant/message' || event.data.interrupted) continue
    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text.trim()).filter(Boolean).join('\n')
    if (text) messages.push(text)
  }
  return messages.join('\n\n').trim()
}

function textContent(content: readonly { type: string; text?: string }[]): string {
  return content.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim()).filter(Boolean).join('\n')
}
