import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { ChannelSession, ChannelView, Companion, PairingRequest, WeixinChannel } from '../domain.js'
import { PartnerStore } from '../store.js'
import { PartnerCredentialVault } from '../credentials.js'
import { PartnerAgentRuntime } from '../agent-runtime.js'
import { WeixinApi } from './weixin/api.js'
import type { WeixinRawItem, WeixinRawMessage } from './weixin/types.js'
import { receiveWeixinMedia } from './weixin/media.js'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { completedTurnEvents, extractOutboundAttachments, partnerCwd, selectTaskNotificationRoute } from '../agent-runtime.js'
import type { PartnerReply } from '../channel-message.js'
import { concernCreatedNoticeFromEvent } from '../concern-notification.js'
import type { BoardTask } from '../tasks/domain.js'
import { prepareTaskResultDelivery } from '../tasks/result.js'

type ChannelContext = Context & { apiProxy: ApiProxy; settings: SettingsProvider }

interface PendingQuestion {
  rpcId: ReturnType<typeof RpcId>
  sessionId: string
  questions: AskUserQuestionItem[]
}

interface RuntimeState {
  status: 'stopped' | 'starting' | 'running' | 'error'
  lastError?: string
}

export class ChannelManager {
  private readonly tasks = new Map<string, { controller: AbortController; task: Promise<void> }>()
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly contextTokens = new Map<string, string>()
  private readonly operations = new Map<string, Set<Promise<void>>>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly outboundQueues = new Map<string, Promise<void>>()
  private interactionController: AbortController | undefined
  private interactionTask: Promise<void> | undefined

  constructor(
    private readonly ctx: ChannelContext,
    private readonly store: PartnerStore,
    private readonly credentials: PartnerCredentialVault,
    private readonly agents: PartnerAgentRuntime,
    private readonly defaultCwd: string,
  ) {}

  startInteractionBridge(): void {
    if (this.interactionTask !== undefined) return
    const controller = new AbortController()
    this.interactionController = controller
    this.interactionTask = this.consumeInteractions(controller.signal).catch(error => {
      if (!controller.signal.aborted) this.ctx.logger.error(`dsh-partner: question bridge stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async views(): Promise<ChannelView[]> {
    return Promise.all(this.store.snapshot().channels.map(async channel => {
      const runtime = this.runtime.get(channel.id) ?? { status: 'stopped' as const }
      return {
        ...channel,
        runtimeStatus: runtime.status,
        ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
        credentialConfigured: await this.credentials.configured(channel.id),
      }
    }))
  }

  async startEnabled(): Promise<void> {
    for (const channel of this.store.snapshot().channels) if (channel.enabled) await this.start(channel.id)
  }

  async start(channelId: string): Promise<void> {
    if (this.tasks.has(channelId)) return
    const channel = requiredChannel(this.store, channelId)
    const credential = await this.credentials.read(channelId)
    const controller = new AbortController()
    this.runtime.set(channelId, { status: 'starting' })
    const task = this.pollLoop(channel, new WeixinApi(credential.baseUrl, credential.botToken), controller.signal)
      .catch(error => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          this.runtime.set(channelId, { status: 'error', lastError: message })
          this.ctx.logger.error(`dsh-partner: WeChat channel ${channelId} stopped: ${message}`)
        }
      }).finally(() => { this.tasks.delete(channelId) })
    this.tasks.set(channelId, { controller, task })
  }

  async stop(channelId: string): Promise<void> {
    const running = this.tasks.get(channelId)
    if (running !== undefined) {
      running.controller.abort()
      await running.task.catch(() => {})
    }
    this.tasks.delete(channelId)
    this.runtime.set(channelId, { status: 'stopped' })
  }

  async close(): Promise<void> {
    this.interactionController?.abort()
    await this.interactionTask?.catch(() => {})
    this.interactionController = undefined
    this.interactionTask = undefined
    this.pendingQuestions.clear()
    await Promise.all([...this.tasks.keys()].map(id => this.stop(id)))
  }

  async delete(channelId: string): Promise<void> {
    await this.stop(channelId)
    await this.agents.resetChannel(channelId)
    await this.store.update(state => {
      state.channels = state.channels.filter(item => item.id !== channelId)
      state.pairings = state.pairings.filter(item => item.channelId !== channelId)
    })
    await this.credentials.delete(channelId)
  }

  async setEnabled(channelId: string, enabled: boolean): Promise<void> {
    requiredChannel(this.store, channelId)
    await this.store.update(state => {
      const channel = state.channels.find(item => item.id === channelId)
      if (channel) { channel.enabled = enabled; channel.updatedAt = Date.now() }
    })
    if (enabled) await this.start(channelId)
    else await this.stop(channelId)
  }

  async sendProactive(channelId: string, userId: string, text: string): Promise<void> {
    await this.sendProactiveReply(channelId, userId, { text, attachments: [] })
  }

  async notifyTaskResult(task: BoardTask): Promise<void> {
    if (!task.creatorCompanionId || (task.status !== 'done' && task.status !== 'blocked')) return
    const routes = this.store.snapshot().sessions.filter(item => item.companionId === task.creatorCompanionId)
    const route = selectTaskNotificationRoute(routes, task.creatorSessionId, () => false)
    if (!route || route.kind === 'local') return
    const cwd = route.cwd ?? partnerCwd(this.defaultCwd, task.creatorCompanionId)
    const delivery = await prepareTaskResultDelivery(task, cwd)
    await this.queueProactive(route, `task-result:${task.id}:${task.revision}:${task.status}`, {
      text: delivery.text,
      attachments: await extractOutboundAttachments(delivery.text, cwd),
    })
  }

  async observeAutonomousResult(session: Session, event: SessionEvent): Promise<void> {
    const route = this.store.snapshot().sessions.find(item => item.sessionId === session.id)
    if (route === undefined || route.kind === 'local') return
    const concernNotice = concernCreatedNoticeFromEvent(event)
    if (concernNotice !== undefined) {
      await this.queueProactive(route, `concern-created:${session.id}:${event.seq}`, { text: concernNotice, attachments: [] })
      return
    }
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const events = completedTurnEvents(session.events, event)
    if (!isAutonomousDeliveryTurn(events)) return
    const text = events
      .filter(item => item.type === 'assistant/message' && !item.data.interrupted)
      .map(item => item.type === 'assistant/message' ? item.data.message.content
        .filter(block => block.type === 'text').map(block => block.text).join('\n') : '')
      .filter(Boolean).join('\n\n').trim()
    if (!text) return
    const receipt = `outbound:${session.id}:${event.data.turn}`
    await this.queueProactive(route, receipt, { text, attachments: route.cwd ? await extractOutboundAttachments(text, route.cwd) : [] })
  }

  private async queueProactive(route: ChannelSession, receipt: string, reply: PartnerReply): Promise<void> {
    if (this.store.snapshot().recentReceipts.includes(receipt)) return
    const key = `${route.channelId}:${route.userId}`
    const previous = this.outboundQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      if (this.store.snapshot().recentReceipts.includes(receipt)) return
      await this.sendProactiveReply(route.channelId, route.userId, reply)
      await this.rememberReceipt(receipt)
    })
    this.outboundQueues.set(key, current)
    try { await current } finally { if (this.outboundQueues.get(key) === current) this.outboundQueues.delete(key) }
  }

  private async sendProactiveReply(channelId: string, userId: string, reply: PartnerReply): Promise<void> {
    const channel = requiredChannel(this.store, channelId)
    if (!channel.enabled) throw new Error('微信渠道已停用')
    const pairing = this.store.snapshot().pairings.find(item => item.channelId === channelId && item.userId === userId)
    if (pairing?.status !== 'approved') throw new Error('微信联系人尚未批准')
    const credential = await this.credentials.read(channelId)
    const token = this.contextTokens.get(`${channelId}:${userId}`)
    const api = new WeixinApi(credential.baseUrl, credential.botToken)
    const signal = AbortSignal.timeout(30_000)
    await api.sendText(userId, reply.text, token, signal)
    for (const attachment of reply.attachments) await api.sendAttachment(userId, attachment, token, signal)
  }

  private async pollLoop(channel: WeixinChannel, api: WeixinApi, signal: AbortSignal): Promise<void> {
    let buffer = ''
    let timeoutMs = 35_000
    let failures = 0
    this.runtime.set(channel.id, { status: 'running' })
    while (!signal.aborted) {
      try {
        const response = await api.getUpdates(buffer, timeoutMs, signal)
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) throw new Error(response.errmsg || `微信 getupdates 返回 ${response.errcode ?? response.ret}`)
        failures = 0
        if (response.get_updates_buf !== undefined) buffer = response.get_updates_buf
        if (response.longpolling_timeout_ms !== undefined) timeoutMs = Math.min(120_000, Math.max(5_000, response.longpolling_timeout_ms))
        for (const message of response.msgs ?? []) this.scheduleInbound(channel, api, message, signal)
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        if (failures >= 6) throw error
        await delay(Math.min(15_000, 1_000 * 2 ** (failures - 1)), signal)
      }
    }
  }

  private scheduleInbound(channel: WeixinChannel, api: WeixinApi, message: WeixinRawMessage, signal: AbortSignal): void {
    const operations = this.operations.get(channel.id) ?? new Set<Promise<void>>()
    this.operations.set(channel.id, operations)
    const operation = this.handleInbound(channel, api, message, signal).catch(error => {
      if (!signal.aborted) this.ctx.logger.error(`dsh-partner: WeChat message ${stableEventId(message) ?? 'unknown'} failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { operations.delete(operation) })
    operations.add(operation)
  }

  private async handleInbound(channel: WeixinChannel, api: WeixinApi, message: WeixinRawMessage, signal: AbortSignal): Promise<void> {
    if (message.message_type !== undefined && message.message_type !== 1) return
    const userId = message.from_user_id?.trim()
    const eventId = stableEventId(message)
    if (!userId || !eventId) return
    const receipt = `${channel.id}:${eventId}`
    if (this.store.snapshot().recentReceipts.includes(receipt)) return
    const items = message.item_list ?? []
    const text = extractText(items)
    const tokenKey = `${channel.id}:${userId}`
    if (message.context_token) this.contextTokens.set(tokenKey, message.context_token)
    const pairing = this.store.snapshot().pairings.find(item => item.channelId === channel.id && item.userId === userId)
    if (pairing?.status !== 'approved') {
      if (pairing?.status !== 'blocked' && pairing === undefined) {
        const now = Date.now()
        const request: PairingRequest = {
          id: `pairing-${randomBytes(10).toString('hex')}`,
          channelId: channel.id,
          userId,
          displayName: shortIdentity(userId),
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        }
        await this.store.update(state => { state.pairings.push(request) })
        await api.sendText(userId, '配对请求已送达 DSH。请在「伙伴 → 微信」中批准后，再发送一条消息。', message.context_token, signal)
      }
      await this.rememberReceipt(receipt)
      return
    }
    const route = this.store.snapshot().sessions.find(item => item.channelId === channel.id && item.userId === userId)
    if (route !== undefined && text && await this.answerPendingQuestion(route.sessionId, text, channel, api, userId, signal)) {
      await this.rememberReceipt(receipt)
      return
    }
    const attachments = []
    const mediaErrors: string[] = []
    for (const item of items) {
      if (item.type !== 2 && item.type !== 4) continue
      try {
        const attachment = await receiveWeixinMedia(item, signal)
        if (attachment) attachments.push(attachment)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        mediaErrors.push(detail)
        this.ctx.logger.warn(`dsh-partner: WeChat attachment ${eventId} failed: ${detail}`)
      }
    }
    const inboundText = [text, ...mediaErrors.map(detail => `[微信附件读取失败：${detail}]`)].filter(Boolean).join('\n\n')
    if (!inboundText && attachments.length === 0) return
    const companion = requiredCompanion(this.store, channel.companionId)
    if (busyEnterMode(this.ctx.settings) === 'steer' && await this.agents.steer(companion, channel.id, userId, { text: inboundText, attachments })) {
      await this.rememberReceipt(receipt)
      return
    }
    const reply = await this.agents.reply(companion, channel.id, userId, { text: inboundText, attachments })
    await api.sendText(userId, reply.text, this.contextTokens.get(tokenKey), signal)
    for (const attachment of reply.attachments) {
      try { await api.sendAttachment(userId, attachment, this.contextTokens.get(tokenKey), signal) }
      catch (error) { this.ctx.logger.warn(`dsh-partner: WeChat outbound attachment ${attachment.path} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    await this.rememberReceipt(receipt)
  }

  private async consumeInteractions(signal: AbortSignal): Promise<void> {
    const stream = this.ctx.apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    for await (const frame of stream) {
      if (signal.aborted) continue
      if (frame.payload.type === 'question/resolved') {
        const pending = this.pendingQuestions.get(frame.payload.sessionId)
        if (pending?.rpcId === frame.payload.questionRpcId) this.pendingQuestions.delete(frame.payload.sessionId)
        continue
      }
      if (frame.payload.type !== 'question/requested') continue
      const request = frame.payload
      const route = this.store.snapshot().sessions.find(item => item.sessionId === request.sessionId)
      if (route === undefined || this.pendingQuestions.get(route.sessionId)?.rpcId === frame.rpcId) continue
      const channel = this.store.snapshot().channels.find(item => item.id === route.channelId)
      const pairing = this.store.snapshot().pairings.find(item => item.channelId === route.channelId && item.userId === route.userId)
      if (channel === undefined || !channel.enabled || pairing?.status !== 'approved') continue
      const pending: PendingQuestion = { rpcId: frame.rpcId, sessionId: route.sessionId, questions: request.questions }
      this.pendingQuestions.set(route.sessionId, pending)
      try {
        const credential = await this.credentials.read(channel.id)
        const api = new WeixinApi(credential.baseUrl, credential.botToken)
        await api.sendText(route.userId, renderQuestions(pending.questions), this.contextTokens.get(`${channel.id}:${route.userId}`), signal)
      } catch (error) {
        this.pendingQuestions.delete(route.sessionId)
        this.ctx.logger.warn(`dsh-partner: failed to deliver question for ${route.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async answerPendingQuestion(sessionId: string, text: string, channel: WeixinChannel, api: WeixinApi, userId: string, signal: AbortSignal): Promise<boolean> {
    const pending = this.pendingQuestions.get(sessionId)
    if (pending === undefined) return false
    const answer = answerQuestions(pending.questions, text)
    const receipt = await this.ctx.apiProxy.respond({
      type: 'client-response', rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId, answer } },
    })
    if (!receipt.accepted) {
      if (receipt.reason === 'not-pending') this.pendingQuestions.delete(sessionId)
      else await api.sendText(userId, '这个回答格式没有匹配当前问题，请按选项序号回复。', this.contextTokens.get(`${channel.id}:${userId}`), signal)
      return true
    }
    this.pendingQuestions.delete(sessionId)
    return true
  }

  private async rememberReceipt(receipt: string): Promise<void> {
    await this.store.update(state => {
      state.recentReceipts.push(receipt)
      if (state.recentReceipts.length > 800) state.recentReceipts.splice(0, state.recentReceipts.length - 800)
    })
  }
}

export function isAutonomousDeliveryTurn(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'tool-goal'
    && event.data.source.form === 'notice'
    && event.data.source.summary?.startsWith('complete:'))
}

export function requiredChannel(store: PartnerStore, id: string): WeixinChannel {
  const channel = store.snapshot().channels.find(item => item.id === id)
  if (channel === undefined) throw new Error('微信渠道不存在')
  return channel
}

export function requiredCompanion(store: PartnerStore, id: string): Companion {
  const companion = store.snapshot().companions.find(item => item.id === id)
  if (companion === undefined) throw new Error('伙伴不存在')
  return companion
}

function stableEventId(message: WeixinRawMessage): string | undefined {
  const id = message.message_id ?? message.msg_id
  if (id !== undefined && String(id).trim()) return `message:${String(id)}`
  if (message.seq !== undefined) return `seq:${message.seq}`
  return undefined
}

export function extractText(items: WeixinRawItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text?.trim()) parts.push(item.text_item.text.trim())
    else if (item.type === 3 && item.voice_item?.text?.trim()) parts.push(item.voice_item.text.trim())
  }
  return parts.join('\n\n')
}

export function renderQuestions(questions: AskUserQuestionItem[]): string {
  const sections = questions.map((question, questionIndex) => {
    const title = question.header?.trim() || `问题 ${questionIndex + 1}`
    const options = (question.options ?? []).map((option, optionIndex) =>
      `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    return [`【${title}】`, question.question, ...(question.detail ? [question.detail] : []), ...options].join('\n')
  })
  const instruction = questions.length === 1
    ? '请回复选项序号、选项文字，或直接输入你的答案。'
    : '请按问题顺序用分号分隔回答，例如：1；2,3；自定义答案。'
  return [...sections, instruction].join('\n\n')
}

export function answerQuestions(questions: AskUserQuestionItem[], text: string): AskUserQuestionAnswer {
  const segments = text.split(/[；;]/).map(item => item.trim())
  return { answers: questions.map((question, index) => answerQuestion(question, segments[index] ?? '')) }
}

function answerQuestion(question: AskUserQuestionItem, value: string): AskUserQuestionAnswer['answers'][number] {
  const options = question.options ?? []
  if (options.length === 0) return { id: question.id, selected: [], ...(value ? { custom: value } : {}) }
  const parts = question.multiSelect === true ? value.split(/[,，、]/).map(item => item.trim()).filter(Boolean) : [value]
  const selected: string[] = []
  const custom: string[] = []
  for (const part of parts) {
    const numeric = /^\d+$/.test(part) ? options[Number(part) - 1]?.label : undefined
    const exact = options.find(option => option.label === part)?.label
    const label = numeric ?? exact
    if (label !== undefined && !selected.includes(label)) selected.push(label)
    else if (part) custom.push(part)
  }
  if (question.multiSelect !== true && custom.length > 0) return { id: question.id, selected: [], custom: custom.join('，') }
  return { id: question.id, selected, ...(custom.length > 0 ? { custom: custom.join('，') } : {}) }
}

function shortIdentity(value: string): string {
  return `微信用户 · ${[...value].slice(-6).join('')}`
}

export function busyEnterMode(settings: Pick<SettingsProvider, 'get'>): 'queue' | 'steer' {
  const section = settings.get(settingsNamespace('ui-conversation')) as { busyEnter?: unknown } | undefined
  return section?.busyEnter === 'steer' ? 'steer' : 'queue'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
