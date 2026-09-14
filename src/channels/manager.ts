import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import type { ChannelSession, ChannelView, Companion, PairingRequest, WeixinChannel } from '../domain.js'
import { PartnerStore } from '../store.js'
import { PartnerCredentialVault } from '../credentials.js'
import { PartnerAgentRuntime } from '../agent-runtime.js'
import { WeixinApi } from './weixin/api.js'
import { DirectTransport, ChannelHttpError, type ChannelSender, type DirectMessage } from './direct/transport.js'
import { notificationRoutes } from './notification-route.js'
import { NotificationDelivery } from './notification-delivery.js'
import { ReplyProgressController } from './reply-progress-controller.js'
import type { WeixinRawItem, WeixinRawMessage } from './weixin/types.js'
import { receiveWeixinMedia } from './weixin/media.js'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { completedTurnEvents, extractOutboundAttachments, partnerCwd, selectTaskNotificationRoute } from '../agent-runtime.js'
import type { PartnerReply, PartnerOutboundAttachment } from '../channel-message.js'
import { concernCreatedNoticeFromEvent } from '../concern-notification.js'
import type { BoardTask } from '../tasks/domain.js'
import { prepareTaskResultDelivery } from '../tasks/result.js'
import type { BoardRequirement } from '../requirements/domain.js'
import { requirementIsIdle, requirementProgressKey } from '../requirements/progress.js'
import { channelReplyPartsAfter, isAutonomousDeliveryTurn } from './delivery-policy.js'
import { prepareChannelReply } from './outbound-media.js'
export { isAutonomousDeliveryTurn } from './delivery-policy.js'

type ChannelContext = Context & { settings: SettingsProvider }
class DirectDeliveryError extends Error {
  constructor() { super('消息处理或发送未完成，渠道已暂停。请在 DSH 查看执行结果后重连；同一消息不会自动重复执行。') }
}

interface PendingQuestion {
  sessionId: string
  questions: AskUserQuestionItem[]
  resolve(answer: AskUserQuestionAnswer): void
  reject(error: unknown): void
  detachAbort(): void
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
  private readonly notificationDelivery: NotificationDelivery

  constructor(
    private readonly ctx: ChannelContext,
    private readonly store: PartnerStore,
    private readonly credentials: PartnerCredentialVault,
    private readonly agents: PartnerAgentRuntime,
    private readonly defaultCwd: string,
  ) { this.notificationDelivery = new NotificationDelivery(store) }

  attachQuestionAnswerer(agentCtx: Context, route: ChannelSession): () => void {
    return agentCtx.on('user-questions/request', (request, next) => this.askThroughChannel(route, request, next), { prepend: true })
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
    for (const channel of this.store.snapshot().channels) if (channel.enabled) {
      try { await this.start(channel.id) }
      catch { this.runtime.set(channel.id,{status:'error',lastError:'渠道启动失败，请检查凭据和配置'}) }
    }
  }

  async start(channelId: string): Promise<void> {
    if (this.tasks.has(channelId)) return
    const channel = requiredChannel(this.store, channelId)
    const credential = await this.credentials.read(channelId)
    const controller = new AbortController()
    this.runtime.set(channelId, { status: 'starting' })
    const task = (channel.platform && channel.platform !== 'weixin'
      ? this.directLoop(channel, controller.signal)
      : this.pollLoop(channel, new WeixinApi(credential.baseUrl, credential.botToken), controller.signal))
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
    for (const pending of this.pendingQuestions.values()) {
      pending.detachAbort()
      pending.reject(new Error('伙伴渠道已停止'))
    }
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

  async sendProactive(channelId: string, userId: string, text: string, receipt?: string): Promise<void> {
    await this.sendProactiveReply(channelId, userId, { text, attachments: [] }, receipt)
  }

  async sendExplicitAttachment(sessionId: string, file: PartnerOutboundAttachment, signal: AbortSignal): Promise<void> {
    const route=this.store.snapshot().sessions.find(s=>s.sessionId===sessionId)
    if(!route||route.kind==='local')throw new Error('当前会话没有绑定渠道')
    const channel=requiredChannel(this.store,route.channelId)
    if(!channel.enabled)throw new Error('渠道已停用')
    if(this.store.snapshot().pairings.find(p=>p.channelId===route.channelId&&p.userId===route.userId)?.status!=='approved')throw new Error('渠道联系人尚未批准')
    const credential=await this.credentials.read(route.channelId)
    await this.sender(channel, credential, route.userId).sendAttachment(route.userId,file,this.contextTokens.get(`${route.channelId}:${route.userId}`),signal)
  }

  async notifyTaskResult(task: BoardTask): Promise<void> {
    if (task.requirementId) return
    if (!task.creatorCompanionId || (task.status !== 'done' && task.status !== 'blocked')) return
    const routes = this.store.snapshot().sessions.filter(item => item.companionId === task.creatorCompanionId)
    const route = selectTaskNotificationRoute(routes, task.creatorSessionId, () => false)
    if (!route || (route.kind === 'local' && !this.store.snapshot().companions.find(c=>c.id===route.companionId)?.notificationDelivery)) return
    const cwd = route.cwd ?? partnerCwd(this.defaultCwd, task.creatorCompanionId)
    const delivery = await prepareTaskResultDelivery(task, cwd)
    await this.queueProactive(route, `task-result:${task.id}:${task.revision}:${task.status}`, {
      text: delivery.text,
      attachments: await extractOutboundAttachments(delivery.text, cwd),
    })
  }

  async notifyRequirementResult(item: BoardRequirement): Promise<void> {
    const stage = item.status !== 'done'
    const summary = stage ? item.stageReport?.summary : item.summary
    if (!summary || !item.creatorSessionId) return
    // A manually created board requirement must not leak into an unrelated chat.
    const route = this.routeForSession(item.creatorSessionId)
    if (!route || (route.kind === 'local' && !this.store.snapshot().companions.find(c=>c.id===route.companionId)?.notificationDelivery)) return
    const cwd = route.cwd ?? partnerCwd(this.defaultCwd, route.companionId)
    const delivery = await prepareTaskResultDelivery({ id: stage ? `${item.id}-stage-${item.stageReport!.key.slice(0, 16)}` : item.id, title: item.title, description: item.description, status: 'done', priority: 'normal', createdBy: 'companion', skillIds: [], dependencyTaskIds: [], revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt, resultSummary: summary }, cwd)
    const text = delivery.text.replace(/^看板任务已完成：/, stage ? '需求阶段结果：' : '需求已完成：')
    const state = this.store.snapshot()
    const latest = state.requirements?.find(r => r.id === item.id)
    if (!latest || latest.revision !== item.revision || latest.status !== item.status ||
      (stage && (!requirementIsIdle(state, latest) || requirementProgressKey(state, latest) !== item.stageReport!.key))) throw new Error('需求已调整，取消旧结果投递')
    // queueProactive persists a stable receipt; retries do not re-summarize.
    await this.queueProactive(route, stage ? `requirement-stage:${item.id}:${item.stageReport!.key}` : `requirement-result:${item.id}:${item.revision}`, { text, attachments: await extractOutboundAttachments(text, cwd) }, () => {
      const state = this.store.snapshot(), latest = state.requirements?.find(r => r.id === item.id)
      return Boolean(latest && latest.revision === item.revision && latest.status === item.status &&
        (!stage || (requirementIsIdle(state, latest) && requirementProgressKey(state, latest) === item.stageReport!.key)))
    })
  }

  async observeAutonomousResult(session: Session, event: SessionEvent): Promise<void> {
    const route = this.routeForSession(session.id)
    if (route === undefined || (route.kind === 'local' && !this.store.snapshot().companions.find(c=>c.id===route.companionId)?.notificationDelivery)) return
    const concernNotice = concernCreatedNoticeFromEvent(event)
    if (concernNotice !== undefined) {
      await this.queueProactive(route, `concern-created:${session.id}:${event.seq}`, { text: concernNotice, attachments: [] })
      return
    }
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const history = session.snapshotEvents().filter(item => item.seq < event.seq)
    const events = completedTurnEvents(history, event)
    if (!isAutonomousDeliveryTurn(events, history)) return
    const parts = channelReplyPartsAfter(events, 0, true)
    if (!parts.text && !parts.referenceTexts.length) return
    const receipt = `outbound:${session.id}:${event.data.turn}`
    await this.queueProactive(route, receipt, await prepareChannelReply(parts, route.cwd ?? partnerCwd(this.defaultCwd, route.companionId)))
  }

  private async queueProactive(route: ChannelSession, receipt: string, reply: PartnerReply, stillValid?: () => boolean): Promise<void> {
    if (this.store.snapshot().recentReceipts.includes(receipt)) return
    const key = `${route.channelId}:${route.userId}`
    const previous = this.outboundQueues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      if (this.store.snapshot().recentReceipts.includes(receipt)) return
      if (stillValid && !stillValid()) throw new Error('需求已调整，取消旧结果投递')
      await this.sendProactiveReply(route.channelId, route.userId, reply, receipt, route.companionId)
      await this.rememberReceipt(receipt)
    })
    this.outboundQueues.set(key, current)
    try { await current } finally { if (this.outboundQueues.get(key) === current) this.outboundQueues.delete(key) }
  }

  private routeForSession(sessionId:string):ChannelSession|undefined {
    const state=this.store.snapshot()
    const candidates=state.sessions.filter(item=>item.sessionId===sessionId)
    const inbound=(route:ChannelSession)=>state.pairings.find(p=>p.channelId===route.channelId&&p.userId===route.userId)?.lastInboundAt??0
    return candidates.filter(item=>item.kind==='channel').sort((a,b)=>inbound(b)-inbound(a))[0]??candidates[0]
  }

  private async sendProactiveReply(channelId: string, userId: string, reply: PartnerReply, receipt?: string, owner?: string): Promise<void> {
    const state = this.store.snapshot()
    const companionId = state.channels.find(c => c.id === channelId)?.companionId ?? owner
    if (!companionId) throw new Error('通知来源伙伴不存在')
    await this.notificationDelivery.deliver(receipt ?? randomBytes(16).toString('hex'), companionId,
      () => notificationRoutes(this.store.snapshot(),channelId,userId,companionId), reply,
      async (target, payload, sendPart) => {
        const current = this.store.snapshot()
        if (!current.channels.some(c => c.id === target.channelId && c.companionId === companionId)) throw new Error('通知目标不属于当前伙伴')
        await this.sendNotificationTarget(target.channelId, target.userId, payload, sendPart)
      })
  }
  private async sendNotificationTarget(channelId: string, userId: string, reply: PartnerReply, sendPart: (part:number, send:()=>Promise<unknown>)=>Promise<void>): Promise<void> {
    const channel = requiredChannel(this.store, channelId)
    if (!channel.enabled) throw new Error('通知渠道已停用')
    const pairing = this.store.snapshot().pairings.find(item => item.channelId === channelId && item.userId === userId)
    if (pairing?.status !== 'approved') throw new Error('通知接收人尚未批准')
    const credential = await this.credentials.read(channelId)
    const token = this.contextTokens.get(`${channelId}:${userId}`)
    const api = this.sender(channel, credential, userId)
    const signal = AbortSignal.timeout(30_000)
    await sendPart(0, () => api.sendText(userId, reply.text, token, signal))
    for (const [index, attachment] of reply.attachments.entries()) await sendPart(index + 1, () => api.sendAttachment(userId, attachment, token, signal))
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
    await this.markInbound(channel.id,userId)
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
      catch (error) {
        this.ctx.logger.warn(`dsh-partner: WeChat outbound attachment ${attachment.path} failed: ${error instanceof Error ? error.message : String(error)}`)
        await api.sendText(userId, `附件「${attachment.name}」发送失败，未完成交付。可以稍后要求重新发送该附件，无需重新生成。`, this.contextTokens.get(tokenKey), signal)
      }
    }
    await this.rememberReceipt(receipt)
  }

  private async askThroughChannel(
    route: ChannelSession,
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (route.kind === 'local' || request.signal?.aborted || this.pendingQuestions.has(route.sessionId)) return next()
    const state = this.store.snapshot()
    const current = state.sessions.find(item => item.id === route.id && item.sessionId === route.sessionId)
    const channel = state.channels.find(item => item.id === route.channelId)
    // Direct connectors currently serialize reads with replies; interactive questions
    // stay in DSH rather than waiting for an answer on a blocked receive loop.
    if (channel?.platform && channel.platform !== 'weixin') return next()
    const pairing = state.pairings.find(item => item.channelId === route.channelId && item.userId === route.userId)
    if (current === undefined || channel === undefined || !channel.enabled || pairing?.status !== 'approved') return next()

    let resolveAnswer!: (answer: AskUserQuestionAnswer) => void
    let rejectAnswer!: (error: unknown) => void
    const answer = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      resolveAnswer = resolve
      rejectAnswer = reject
    })
    void answer.catch(() => {})
    const abort = (): void => rejectAnswer(request.signal?.reason ?? new Error('用户提问已取消'))
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    const pending: PendingQuestion = {
      sessionId: route.sessionId,
      questions: request.questions,
      resolve: resolveAnswer,
      reject: rejectAnswer,
      detachAbort: () => request.signal?.removeEventListener('abort', abort),
    }
    this.pendingQuestions.set(route.sessionId, pending)
    try {
      const credential = await this.credentials.read(channel.id)
      const api = this.sender(channel, credential, route.userId)
      await api.sendText(route.userId, renderQuestions(request.questions), this.contextTokens.get(`${channel.id}:${route.userId}`), request.signal ?? AbortSignal.timeout(30_000))
    } catch (error) {
      this.clearPendingQuestion(pending)
      if (request.signal?.aborted) throw error
      this.ctx.logger.warn(`dsh-partner: failed to deliver question for ${route.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    try {
      return await answer
    } finally {
      this.clearPendingQuestion(pending)
    }
  }

  private async answerPendingQuestion(sessionId: string, text: string, channel: WeixinChannel, api: ChannelSender, userId: string, signal: AbortSignal): Promise<boolean> {
    const pending = this.pendingQuestions.get(sessionId)
    if (pending === undefined) return false
    const answer = answerQuestions(pending.questions, text)
    pending.resolve(answer)
    this.clearPendingQuestion(pending)
    return true
  }

  private clearPendingQuestion(pending: PendingQuestion): void {
    if (this.pendingQuestions.get(pending.sessionId) === pending) this.pendingQuestions.delete(pending.sessionId)
    pending.detachAbort()
  }

  private async rememberReceipt(receipt: string): Promise<void> {
    await this.store.update(state => {
      state.recentReceipts.push(receipt)
      if (state.recentReceipts.length > 800) state.recentReceipts.splice(0, state.recentReceipts.length - 800)
    })
  }

  private sender(channel: WeixinChannel, credential: {baseUrl: string; botToken: string}, userId: string): ChannelSender {
    if (!channel.platform || channel.platform === 'weixin') return new WeixinApi(credential.baseUrl, credential.botToken)
    if (!channel.direct) throw new Error('渠道会话配置缺失')
    const pairing=this.store.snapshot().pairings.find(p=>p.channelId===channel.id&&p.userId===userId&&p.status==='approved')
    const targetId=channel.direct.targetId||pairing?.directTargetId
    if(!targetId)throw new Error('联系人尚未绑定私聊会话')
    return new DirectTransport({platform:channel.platform,baseUrl:credential.baseUrl,targetId},credential.botToken,{accountId:channel.accountId,peerId:channel.direct.peerId||userId})
  }

  /** Independent connector loop. Cursor is persisted only after receipt handoff. */
  private async directLoop(channel: WeixinChannel, signal: AbortSignal): Promise<void> {
    if (!channel.direct || !channel.platform || channel.platform==='weixin') throw new Error('渠道配置无效')
    const credential = await this.credentials.read(channel.id)
    const api = new DirectTransport({platform:channel.platform,baseUrl:credential.baseUrl,targetId:channel.direct.targetId},credential.botToken,{accountId:channel.accountId,peerId:channel.direct.peerId})
    let cursor=channel.direct.cursor
    let failures=0
    let roomWarning: string | undefined
    while(!signal.aborted) {
      try {
        const batch=await api.poll(cursor,signal)
        if(signal.aborted)break
        if(batch.warning)roomWarning=batch.warning
        else if(batch.messages.length)roomWarning=undefined
        this.runtime.set(channel.id,{status:'running',...(roomWarning?{lastError:roomWarning}:{})})
        for(const message of batch.messages) {
          if(signal.aborted)break
          try {
            const targetApi=message.targetId?new DirectTransport({platform:channel.platform,baseUrl:credential.baseUrl,targetId:message.targetId},credential.botToken,{accountId:channel.accountId,peerId:message.sender}):api
            await targetApi.validate(signal); await this.handleDirect(channel,targetApi,message,signal)
          }
          catch { throw new DirectDeliveryError() }
        }
        if(signal.aborted)break
        await this.store.update(state=>{
          const current=state.channels.find(c=>c.id===channel.id && c.enabled)
          if(current?.direct)current.direct.cursor=batch.cursor
        })
        cursor=batch.cursor;failures=0
        await delay(channel.platform==='mattermost'?10_000:1000,signal)
      } catch(error) {
        if(signal.aborted)break
        if(error instanceof DirectDeliveryError || (error instanceof ChannelHttpError && [401,403].includes(error.status)))throw error
        if(++failures>=6)throw error
        const reason=error instanceof ChannelHttpError?`HTTP ${error.status}`:error instanceof Error&&error.message==='fetch failed'?'网络连接失败，请检查地址、端口和容器 DNS':error instanceof Error&&error.name==='TimeoutError'?'服务器请求超时':error instanceof Error?error.message:'连接异常'
        this.runtime.set(channel.id,{status:'starting',lastError:`${reason}（重试 ${failures}/6）`})
        await delay(Math.max(error instanceof ChannelHttpError ? error.retryAfterMs : 0,Math.min(60_000,2000*2**failures)),signal)
      }
    }
  }

  private async handleDirect(channel: WeixinChannel, api: DirectTransport, event: DirectMessage, signal: AbortSignal): Promise<void> {
    const receipt=`${channel.id}:${event.id}`
    if(this.store.snapshot().recentReceipts.includes(receipt))return
    const pairing=this.store.snapshot().pairings.find(p=>p.channelId===channel.id && p.userId===event.sender)
    // A different room must not silently inherit the contact's existing grant.
    if(pairing?.directTargetId&&event.targetId&&pairing.directTargetId!==event.targetId){await this.rememberReceipt(receipt);return}
    if(!pairing) {
      const now=Date.now()
      const pairingCode=randomBytes(4).toString('hex').toUpperCase()
      await this.store.update(state=>{
        if(state.pairings.filter(p=>p.channelId===channel.id).length>=100)throw new Error('配对请求已达上限，请在面板清理')
        if(!state.pairings.some(p=>p.channelId===channel.id&&p.userId===event.sender))state.pairings.push({id:`pairing-${randomBytes(10).toString('hex')}`,channelId:channel.id,userId:event.sender,displayName:event.sender,directTargetId:event.targetId||channel.direct?.targetId||'',pairingCode,status:'pending',createdAt:now,updatedAt:now})
      })
      await api.sendText(event.sender,`配对码：${pairingCode}\n请在「伙伴 → 渠道 → 配置」核对该码并批准联系人，然后重新发送消息。未批准前不会交给伙伴处理。`,undefined,signal)
    } else if(pairing.status==='approved') {
      await this.markInbound(channel.id,event.sender)
      if(!event.text)await api.sendText(event.sender,'此渠道首版仅支持文本；附件未交给伙伴处理。',undefined,signal)
      else {
        // Claim before starting tools. A delivery failure must not execute the same
        // user command twice on reconnect; its result remains in the DSH session.
        await this.rememberReceipt(receipt)
        const companion=requiredCompanion(this.store,channel.companionId)
        const allowed=()=>{
          const state=this.store.snapshot()
          return state.channels.some(c=>c.id===channel.id&&c.enabled&&c.companionId===channel.companionId)&&state.pairings.some(p=>p.channelId===channel.id&&p.userId===event.sender&&p.status==='approved'&&(!p.directTargetId||p.directTargetId===(event.targetId||channel.direct?.targetId)))
        }
        const progress=typeof api.progress==='function'?new ReplyProgressController(api.progress(event.sender),allowed,signal):undefined
        progress?.start()
        try {
        const reply=await this.agents.reply(companion,channel.id,event.sender,{text:event.text,attachments:[]},progress?.update)
        signal.throwIfAborted()
        const current=this.store.snapshot()
        if(!current.channels.some(c=>c.id===channel.id&&c.enabled&&c.companionId===channel.companionId)||!current.pairings.some(p=>p.channelId===channel.id&&p.userId===event.sender&&p.status==='approved'))throw new Error('渠道或联系人授权已撤销，取消回复')
        const text=reply.text+(reply.attachments.length?'\n\n附件未交付：此渠道首版只发送文本，请在 DSH 工作区查看文件。':'')
        if(progress)await progress.finish(text)
        else await api.sendText(event.sender,text,undefined,signal)
        } catch(error) {await progress?.fail();throw error}
      }
    }
    await this.rememberReceipt(receipt)
  }

  private async markInbound(channelId: string, userId: string): Promise<void> {
    await this.store.update(state=>{const p=state.pairings.find(p=>p.channelId===channelId&&p.userId===userId&&p.status==='approved');if(p)p.lastInboundAt=Date.now()})
  }
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
  const section = settings.get('ui-conversation') as { busyEnter?: unknown } | undefined
  return section?.busyEnter === 'steer' ? 'steer' : 'queue'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
