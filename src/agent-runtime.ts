import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Companion, ChannelSession } from './domain.js'
import { PartnerStore } from './store.js'
import type { PartnerMemoryStore } from './memory-store.js'
import type { MemoryReflectionService } from './memory-reflection.js'
import type { PartnerInboundMessage, PartnerOutboundAttachment, PartnerReply } from './channel-message.js'
import { PARTNER_MEDIA_MAX_BYTES, safeMediaName } from './channel-message.js'

type RuntimeContext = Context & {
  agents: Context['agents']
  agentDefaultModel: AgentDefaultModelConfig
  agentPresets: AgentPresets
  workspaceRegistry: WorkspaceRegistry
}

export class PartnerAgentRuntime {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly steeringQueues = new Map<string, Promise<void>>()
  private readonly workspaces = new Map<string, Promise<Workspace>>()

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly store: PartnerStore,
    private readonly defaultCwd: string,
    private readonly memory?: PartnerMemoryStore,
    private readonly reflection?: MemoryReflectionService,
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

  async heartbeat(companion: Companion, route: ChannelSession): Promise<string | undefined> {
    const key = `${route.channelId}:${route.userId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    let output: string | undefined
    const current = previous.catch(() => {}).then(async () => { output = await this.driveHeartbeat(companion, route) })
    this.queues.set(key, current)
    try { await current; return output } finally { if (this.queues.get(key) === current) this.queues.delete(key) }
  }

  async observeSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed' || this.reflection === undefined) return
    const route = this.store.snapshot().sessions.find(item => item.sessionId === session.id)
    if (route === undefined) return
    const companion = this.store.snapshot().companions.find(item => item.id === route.companionId)
    if (companion === undefined || !companion.automation.memory.enabled) return
    const events = completedTurnEvents(session.events, event)
    const prompt = events.find(item => item.type === 'user/message' && item.data.source.kind === 'user')
    const replies = events.filter(item => item.type === 'assistant/message' && !item.data.interrupted)
    const userText = prompt?.type === 'user/message' ? textContent(prompt.data.content) : ''
    const assistantText = replies.flatMap(item => item.type === 'assistant/message' ? [textContent(item.data.message.content)] : []).filter(Boolean).join('\n\n')
    if (!userText || !assistantText) return
    await this.reflection.reflect(companion, {
      id: `turn-${randomUUID()}`, companionId: companion.id, scopeId: memoryScope(route.channelId, route.userId),
      sessionId: session.id, at: event.time, user: userText, assistant: assistantText,
    })
    await this.store.update(state => {
      const target = state.sessions.find(item => item.id === route.id)
      if (target) target.lastMessageAt = Date.now()
    })
  }

  private async driveHeartbeat(companion: Companion, route: ChannelSession): Promise<string | undefined> {
    const agent = await this.ensureAgent(companion, route)
    if (agent.status !== 'idle') return undefined
    const recalled = await this.memory?.recall(companion.id, memoryScope(route.channelId, route.userId), '未完成任务 承诺 跟进 风险 提醒', 16).catch(() => [])
    if (recalled && recalled.length > 0) agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderMemory(recalled) }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '心跳召回相关长期记忆' },
    }))
    const startSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: [
        '执行一次伙伴心跳检查。结合当前会话、召回的结构化记忆、每日回顾和可用工具，判断现在是否确实有一条值得主动告诉用户的信息。',
        '检查范围：用户明确交代但尚未完成的事项、承诺过的后续跟进、临近风险，以及通过当前已挂载知识库或工具获得的真正有用的新发现。',
        '所有主动报告必须能从当前会话、该联系人的结构化记忆、每日回顾或工具结果中找到依据；不得为了活跃而寒暄，不得虚构进展，不得重复近期提醒。',
        '如果没有必要通知，只回复：NO_ACTION',
        '如果需要通知，只输出准备发送给用户的简短中文消息，不要解释这是心跳。',
      ].join('\n') }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴正在进行低打扰心跳检查' },
    }))
    await agent.whenIdle()
    const response = extractAssistantText(agent, startSeq).trim()
    if (!response || /^NO_ACTION[。.!！]?$/i.test(response)) return undefined
    return response
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

function renderPersona(companion: Companion): string {
  const capabilities = companion.capabilities.length > 0 ? companion.capabilities.join('、') : '由当前 Agent Preset 提供的基础能力'
  return [
    `你当前以长期工作伙伴「${companion.name}」的身份工作。`,
    `角色：${companion.role}`,
    companion.description ? `定位：${companion.description}` : '',
    companion.instructions ? `长期行为准则：\n${companion.instructions}` : '',
    `用户为此伙伴启用的能力范围：${capabilities}。能力标识不等于授权；只能调用当前会话实际提供且已经通过权限校验的工具。`,
    '这个会话由 DSH 网页与微信私聊渠道共同使用。保持同一上下文，不要假定每条消息都来自微信；渠道回传由适配器负责。回答兼顾网页与移动端阅读，执行外部操作前继续遵守工具自身的授权与审批边界。',
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
