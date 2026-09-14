import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { normalizeAutomation, normalizeCompanionDraft, text, type ChannelView, type Companion } from './domain.js'
import { PartnerStore } from './store.js'
import { PartnerCredentialVault } from './credentials.js'
import { ChannelManager, requiredCompanion } from './channels/manager.js'
import { WeixinLoginManager } from './channels/weixin/login.js'
import { DirectTransport, directConfig } from './channels/direct/transport.js'
import { DirectLoginCache } from './channels/direct/login-cache.js'
import { memoryScope, PartnerAgentRuntime } from './agent-runtime.js'
import { PartnerMemoryStore } from './memory-store.js'
import { HeartbeatScheduler } from './heartbeat.js'
import { DailyReviewScheduler } from './daily-review.js'
import { PartnerConcernStore } from './concern-store.js'
import type { SkillService } from './skills/service.js'
import type { TaskBoardService } from './tasks/service.js'
import type { RequirementService } from './requirements/service.js'
import type { PartnerCollaborationService } from './collaboration/service.js'
import type { PartnerSchedulerService } from './scheduler/service.js'
import type { CompanionService } from './companions/service.js'
import { dispatchPartnerWorkspaceApi } from './api/features/workspace-api.js'
import { dispatchPendantApi } from './api/features/pendant-api.js'
import { dispatchMemoryLayersApi } from './api/features/memory-layers-api.js'
import type { AttachmentDeliveryService } from './attachments/service.js'
import { dispatchAttachmentsApi } from './api/features/attachments-api.js'
import type { PartnerInboxStore } from './notifications/store.js'
import { assertSameOrigin, httpError, mutation, readObject, sendError, sendJson } from './api/http.js'

export interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
}
const loginCaches=new WeakMap<PartnerStore,DirectLoginCache>()
function loginCache(store:PartnerStore):DirectLoginCache {
  let cache=loginCaches.get(store)
  if(!cache){cache=new DirectLoginCache();loginCaches.set(store,cache)}
  return cache
}

interface ApiRuntime {
  ctx: Context & { agentPresets: AgentPresets }
  store: PartnerStore
  credentials: PartnerCredentialVault
  channels: ChannelManager
  agents: PartnerAgentRuntime
  login: WeixinLoginManager
  memory: PartnerMemoryStore
  concerns: PartnerConcernStore
  heartbeat: HeartbeatScheduler
  dailyReview: DailyReviewScheduler
  skills: SkillService
  tasks: TaskBoardService
  requirements?: RequirementService
  collaboration: PartnerCollaborationService
  scheduler: PartnerSchedulerService
  companions: CompanionService
  inbox: PartnerInboxStore
  deliveries?: AttachmentDeliveryService
}

export function registerPartnerApi(webServer: WebServerLike, prefix: string, runtime: ApiRuntime): () => void {
  return webServer.register({
    kind: 'prefix', path: prefix,
    handler: async (req, res) => {
      try {
        assertSameOrigin(req)
        await dispatch(req, res, prefix, runtime)
      } catch (error) { sendError(res, error) }
    },
  })
}

async function dispatch(req: IncomingMessage, res: ServerResponse, prefix: string, runtime: ApiRuntime): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://partner.local')
  const relative = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  const segments = relative ? relative.split('/').map(decodeURIComponent) : []
  const method = req.method ?? 'GET'
  if (segments[0] === 'companions' && segments[1] && runtime.store.isCompanionRemoving(segments[1]) && !(method === 'DELETE' && segments.length === 2)) throw httpError(409, '伙伴正在删除，请稍后刷新')
  if (await dispatchPendantApi(req, res, segments, runtime.inbox)) return
  if (runtime.deliveries && await dispatchAttachmentsApi(req,res,segments,runtime.deliveries,runtime.store)) return
  if (method === 'GET' && segments[0] === 'health') return sendJson(res, 200, { ok: true, service: 'dsh-partner', schemaVersion: 14 })
  if (method === 'GET' && segments[0] === 'models' && segments.length === 1) {
    const providers = await Promise.all(runtime.ctx.llm.listProviders().map(async provider => ({
      id: provider.id, name: provider.name,
      models: (await runtime.ctx.llm.listModels(provider.id).catch(() => [])).map(model => ({ id: model.id, name: model.name })),
    })))
    return sendJson(res, 200, { providers, defaultSelection: runtime.ctx.agentDefaultModel.currentSelection() })
  }
  if (method === 'GET' && segments.length === 0) return sendJson(res, 200, await snapshot(runtime))
  if (await dispatchPartnerWorkspaceApi(req, res, segments, url, runtime)) return

  if (segments[0] === 'companions') {
    if (method === 'POST' && segments.length === 1) {
      mutation(req)
      const companion = await runtime.companions.create((await readObject(req)).companion)
      return sendJson(res, 201, companion)
    }
    const id = segments[1]
    if (id && method === 'PUT' && segments[2] === 'notifications' && segments.length === 3) {
      mutation(req)
      const body = await readObject(req)
      if (body.mode !== 'recent' && body.mode !== 'selected') throw httpError(400, '请选择通知方式')
      if (!Array.isArray(body.targetPairingIds) || body.targetPairingIds.length > 50 || body.targetPairingIds.some(x => typeof x !== 'string')) throw httpError(400, '通知接收人无效')
      const ids = [...new Set(body.targetPairingIds as string[])]
      if (body.mode === 'selected' && !ids.length) throw httpError(400, '请至少选择一个通知接收人')
      await runtime.store.update(state => {
        const companion = state.companions.find(c => c.id === id)
        if (!companion) throw httpError(404, '伙伴不存在')
        const targets = body.mode === 'recent' ? [] : ids.map(pairingId => {
          const pairing = state.pairings.find(p => p.id === pairingId && p.status === 'approved')
          if (!pairing || !state.channels.some(c => c.id === pairing.channelId && c.companionId === id && c.enabled)) throw httpError(400, '请选择本伙伴已启用渠道中的已授权接收人')
          return { channelId: pairing.channelId, userId: pairing.userId }
        })
        companion.notificationDelivery = { mode: body.mode as 'recent' | 'selected', targets }
        companion.updatedAt = Date.now()
      })
      return sendJson(res, 200, {ok: true})
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'session' && segments.length === 3) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const route = await runtime.agents.createLocalSession(id)
      return sendJson(res, 201, { routeId: route.id, sessionId: route.sessionId })
    }
    if (id !== undefined && method === 'PUT' && segments.length === 2) {
      mutation(req)
      const draft = normalizeCompanionDraft((await readObject(req)).companion)
      const saved = await runtime.store.update(state => {
        const previous = state.companions.find(item => item.id === id)
        if (!previous) throw httpError(404, '伙伴不存在')
        const next: Companion = { ...draft, ...(previous.notificationDelivery ? {notificationDelivery: previous.notificationDelivery} : {}), automation: previous.automation, id, createdAt: previous.createdAt, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) }
        state.companions = state.companions.map(item => item.id === id ? next : item)
      })
      const next = saved.companions.find(item => item.id === id)!
      return sendJson(res, 200, next)
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      mutation(req)
      const removeFiles = url.searchParams.get('removeFiles')
      if (removeFiles !== null && removeFiles !== '0' && removeFiles !== '1') throw httpError(400, 'removeFiles 必须为 0 或 1')
      await runtime.companions.remove(id, {
        isBusy: target => runtime.agents.isCompanionBusy(target) || runtime.heartbeat.isRunning(target) || runtime.dailyReview.isRunning(target),
        validateDirectory: target => runtime.agents.validateCompanionDirectory(target),
        ...(removeFiles === '1' ? { removeDirectory: (target: string) => runtime.agents.removeCompanionDirectory(target) } : {}),
        detachWorkspace: target => runtime.agents.removeCompanionWorkspace(target),
        resetSessions: target => runtime.agents.resetCompanion(target),
        clearMemory: target => runtime.memory.clear(target),
        clearConcerns: target => runtime.concerns.clear(target),
      })
      return sendJson(res, 204, undefined)
    }
    if (id !== undefined && method === 'PUT' && segments[2] === 'automation' && segments.length === 3) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const automation = normalizeAutomation((await readObject(req)).automation)
      await runtime.store.update(state => {
        const target = state.companions.find(item => item.id === id)
        if (target) { target.automation = automation; target.updatedAt = Date.now() }
        state.heartbeatStates = state.heartbeatStates.filter(item => item.companionId !== id)
        if (automation.heartbeat.enabled) state.heartbeatStates.push({
          companionId: id,
          nextCheckAt: Date.now() + automation.heartbeat.intervalMinutes * 60_000,
          sentDay: localDay(Date.now()), sentCount: 0, consecutiveFailures: 0,
        })
      })
      return sendJson(res, 200, { automation })
    }
    if (id !== undefined && segments[2] === 'memory') {
      requiredCompanion(runtime.store, id)
      if (await dispatchMemoryLayersApi(req, res, url, segments, runtime.memory, id)) return
      if (method === 'GET' && segments.length === 3) {
        const state = runtime.store.snapshot()
        const routes = state.sessions.filter(item => item.companionId === id)
        const scopes = routes.map(item => memoryScope(item.channelId, item.userId))
        const scopeId = url.searchParams.get('scopeId') ?? undefined
        const [memories, reflections, profiles] = await Promise.all([
          runtime.memory.recentMemories(id, 100, scopeId), scopeId === undefined ? runtime.memory.recentReflections(id, 30) : runtime.memory.recentReflectionsForScope(id, scopeId, 30), runtime.memory.profileSnapshots(id, scopes),
        ])
        return sendJson(res, 200, {
          memories, reflections,
          profiles: profiles.map(profile => {
            const route = routes.find(item => memoryScope(item.channelId, item.userId) === profile.scopeId)
            const pairing = route && state.pairings.find(item => item.channelId === route.channelId && item.userId === route.userId)
            return { ...profile, label: pairing?.displayName || route?.userId || '历史联系人' }
          }),
        })
      }
      const memoryId = segments[3]
      if (method === 'PUT' && memoryId !== undefined && segments.length === 4) {
        mutation(req)
        const body = await readObject(req)
        return sendJson(res, 200, await runtime.memory.updateMemory(id, memoryId, text(body.subject, 'subject', 120), text(body.content, 'content', 800)))
      }
      if (method === 'DELETE' && memoryId !== undefined && segments.length === 4) {
        mutation(req)
        await runtime.memory.deleteMemory(id, memoryId)
        return sendJson(res, 204, undefined)
      }
    }
    if (id !== undefined && segments[2] === 'concerns') {
      requiredCompanion(runtime.store, id)
      if (method === 'GET' && segments.length === 3) return sendJson(res, 200, await runtime.concerns.activity(id))
      if (method === 'GET' && segments.length === 4 && segments[3] === 'archived') {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, '分页参数无效')
        return sendJson(res, 200, await runtime.concerns.archived(id, offset))
      }
      if (method === 'DELETE' && segments.length === 4 && segments[3]) {
        mutation(req)
        const body = await readObject(req)
        if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw httpError(400, '请刷新后重新确认删除')
        await runtime.heartbeat.removeConcern(id, segments[3], body.expectedUpdatedAt as number)
        return sendJson(res, 200, {ok: true})
      }
      if (method === 'PATCH' && segments.length === 4 && segments[3]) {
        mutation(req)
        const body = await readObject(req)
        if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw httpError(400, '缺少关注版本，请刷新后重试')
        if (typeof body.reason !== 'string' || body.reason.length > 800 || typeof body.sources !== 'string' || body.sources.length > 4000) throw httpError(400, '关注说明或依据格式无效')
        const recordTarget = await runtime.agents.validateRecordingTarget(requiredCompanion(runtime.store, id), body.recordTarget)
        return sendJson(res, 200, await runtime.concerns.editExplicit(id, segments[3], {subject:text(body.subject, 'subject', 300), reason:body.reason, sources:body.sources, expectedUpdatedAt:body.expectedUpdatedAt as number, ...(recordTarget ? {recordTarget} : {})}))
      }
      if (method === 'POST' && segments.length === 3) {
        mutation(req)
        const body = await readObject(req)
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 800) : ''
        const recordTarget = await runtime.agents.validateRecordingTarget(requiredCompanion(runtime.store, id), body.recordTarget)
        return sendJson(res, 201, await runtime.concerns.createExplicit(id, '*', text(body.subject, 'subject', 300), reason, recordTarget))
      }
      if (method === 'POST' && segments[3] !== undefined && segments[4] === 'action' && segments.length === 5) {
        mutation(req)
        const action = text((await readObject(req)).action, 'action', 20)
        if (action !== 'watch' && action !== 'ignore' && action !== 'prioritize' && action !== 'resolve') throw httpError(400, 'concern action is invalid')
        await runtime.concerns.act(id, segments[3], action)
        return sendJson(res, 200, { ok: true })
      }
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'concern-sources' && segments.length === 3) {
      const companion = requiredCompanion(runtime.store, id)
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 160)
      return sendJson(res, 200, { items: await runtime.agents.concernSources(companion, query) })
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'recording-sources' && segments.length === 3) {
      return sendJson(res, 200, { items: await runtime.agents.recordingSources(requiredCompanion(runtime.store, id), (url.searchParams.get('q') ?? '').slice(0, 160)) })
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'heartbeat' && segments[3] === 'trigger' && segments.length === 4) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const body = await readObject(req)
      const concernId = typeof body.concernId === 'string' ? body.concernId.trim().slice(0, 160) : undefined
      return sendJson(res, 202, runtime.heartbeat.startManual(id, concernId))
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'heartbeat' && segments[3] === 'status' && segments.length === 4) {
      requiredCompanion(runtime.store, id)
      return sendJson(res, 200, runtime.heartbeat.manualStatus(id))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'memory' && segments[3] === 'review' && segments.length === 4) {
      mutation(req); requiredCompanion(runtime.store, id)
      return sendJson(res, 200, await runtime.dailyReview.trigger(id, true))
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'memory' && segments[3] === 'graph' && segments.length === 4) {
      requiredCompanion(runtime.store, id)
      return sendJson(res, 200, await runtime.memory.relations(id))
    }
  }

  if (segments[0] === 'weixin' && segments[1] === 'login') {
    if (method === 'POST' && segments.length === 2) {
      mutation(req)
      const companionId = text((await readObject(req)).companionId, 'companionId', 120)
      requiredCompanion(runtime.store, companionId)
      return sendJson(res, 201, await runtime.login.begin(companionId))
    }
    const loginId = segments[2]
    if (method === 'GET' && loginId !== undefined && segments.length === 3) {
      const login = await runtime.login.poll(loginId)
      if (login.phase !== 'confirmed') return sendJson(res, 200, { login })
      const confirmed = runtime.login.consume(loginId)
      const now = Date.now()
      const channel = {
        id: createId('weixin'), companionId: confirmed.companionId, accountId: confirmed.accountId,
        name: `微信 · ${confirmed.accountId.slice(-6)}`, enabled: true, createdAt: now, updatedAt: now,
      }
      await runtime.credentials.write(channel.id, { botToken: confirmed.botToken, baseUrl: confirmed.baseUrl })
      try { await runtime.store.update(state => { state.channels.push(channel) }) }
      catch (error) { await runtime.credentials.delete(channel.id).catch(() => {}); throw error }
      await runtime.channels.start(channel.id)
      return sendJson(res, 200, { login, channel })
    }
  }

  if (segments[0] === 'channels') {
    if(method==='GET'&&segments[1]==='status'&&segments.length===2)return sendJson(res,200,{channels:await runtime.channels.views(),pairings:runtime.store.snapshot().pairings})
    if (method === 'POST' && (segments.length === 1 || (segments.length === 2 && segments[1] === 'test'))) {
      mutation(req)
      const body = await readObject(req)
      const companionId = text(body.companionId, 'companionId', 120)
      requiredCompanion(runtime.store, companionId)
      if (runtime.store.isCompanionRemoving(companionId)) throw httpError(409, '伙伴正在删除')
      const config = directConfig(body)
      if(body.authMode!==undefined&&body.authMode!=='password'&&body.authMode!=='token')throw httpError(400,'登录方式无效')
      const login=body.authMode==='password'?await loginCache(runtime.store).acquire(companionId,config,{username:body.username,password:body.password,...(body.mfaToken?{mfaToken:body.mfaToken}:{})}):undefined
      const botToken=login?.token??text(body.botToken,'botToken',8192)
      const adapter = new DirectTransport(config, botToken)
      const identity = await adapter.validate()
      if (segments[1] === 'test') {
        return sendJson(res, 200, {ok: true, ...identity})
      }
      const baseline = await adapter.poll(undefined, AbortSignal.timeout(35_000))
      await new DirectTransport(config, botToken, identity).validate()
      const now = Date.now()
      const channel = {id:createId(config.platform),companionId,platform:config.platform,accountId:identity.accountId,
        name:text(body.name, 'name', 80),enabled:false,createdAt:now,updatedAt:now,
        direct:{baseUrl:config.baseUrl,targetId:config.targetId,peerId:identity.peerId,cursor:baseline.cursor}}
      await runtime.credentials.write(channel.id,{baseUrl:config.baseUrl,botToken})
      try {
        await runtime.store.update(state=>{
          if(state.channels.some(c=>c.platform===config.platform&&c.accountId===identity.accountId&&c.direct?.baseUrl===config.baseUrl))throw httpError(409,'此机器人已配置，请先管理现有渠道，不能绑定到另一个伙伴')
          if(!state.companions.some(c=>c.id===companionId))throw httpError(409,'伙伴已不存在')
          state.channels.push(channel)
          if(identity.peerId)state.pairings.push({id:createId('pairing'),channelId:channel.id,userId:identity.peerId,displayName:identity.peerId,directTargetId:config.targetId,status:'pending',createdAt:now,updatedAt:now})
        })
      } catch(error) {await runtime.credentials.delete(channel.id);throw error}
      login?.retain()
      return sendJson(res,201,{channel})
    }
    const id = segments[1]
    if (id !== undefined && method === 'POST' && segments[2] === 'enabled' && segments.length === 3) {
      mutation(req)
      const body = await readObject(req)
      if (typeof body.enabled !== 'boolean') throw httpError(400, 'enabled must be boolean')
      await runtime.channels.setEnabled(id, body.enabled)
      return sendJson(res, 200, { ok: true })
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      mutation(req)
      await runtime.channels.delete(id)
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'pairings') {
    const id = segments[1]
    if (id && method==='POST' && segments[2]==='delivery' && segments.length===3) {
      mutation(req)
      const body=await readObject(req)
      if(typeof body.contactKey!=='string'||body.contactKey.length>80)throw httpError(400,'联系人关联标识无效')
      if(body.targetPairingId!==null&&typeof body.targetPairingId!=='string')throw httpError(400,'通知目标无效')
      await runtime.store.update(state=>{
        const source=state.pairings.find(p=>p.id===id&&p.status==='approved')
        if(!source)throw httpError(404,'已授权联系人不存在')
        const companion=state.channels.find(c=>c.id===source.channelId)?.companionId
        if(body.targetPairingId!==null) {
          const target=state.pairings.find(p=>p.id===body.targetPairingId&&p.status==='approved')
          if(!target||!state.channels.some(c=>c.id===target.channelId&&c.companionId===companion))throw httpError(400,'只能选择同一伙伴的已授权通知目标')
          source.deliveryTarget={channelId:target.channelId,userId:target.userId}
        } else delete source.deliveryTarget
        if((body.contactKey as string).trim())source.contactKey=(body.contactKey as string).trim()
        else delete source.contactKey
        source.updatedAt=Date.now()
      })
      return sendJson(res,200,{ok:true})
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'status' && segments.length === 3) {
      mutation(req)
      const status = text((await readObject(req)).status, 'status', 20)
      if (status !== 'approved' && status !== 'blocked') throw httpError(400, 'pairing status is invalid')
      const pairing = runtime.store.snapshot().pairings.find(item => item.id === id)
      if (pairing === undefined) throw httpError(404, '配对请求不存在')
      await runtime.store.update(state => {
        const target = state.pairings.find(item => item.id === id)
        if (target) { target.status = status; target.updatedAt = Date.now() }
      })
      return sendJson(res, 200, { ok: true })
    }
  }
  if (segments[0] === 'sessions') {
    const id = segments[1]
    if (id !== undefined && method === 'POST' && segments[2] === 'prepare' && segments.length === 3) {
      mutation(req)
      const route = await runtime.agents.prepareSession(id)
      return sendJson(res, 200, { sessionId: route.sessionId })
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'renew' && segments.length === 3) {
      mutation(req)
      const route = await runtime.agents.renewSession(id)
      await runtime.agents.prepareSession(route.id)
      return sendJson(res, 201, { routeId: route.id, sessionId: route.sessionId })
    }
  }
  throw httpError(404, 'Partner API route was not found')
}

async function snapshot(runtime: ApiRuntime): Promise<{
  companions: Companion[]; channels: ChannelView[]; pairings: ReturnType<PartnerStore['snapshot']>['pairings']; sessions: ReturnType<PartnerStore['snapshot']>['sessions']; heartbeatStates: ReturnType<PartnerStore['snapshot']>['heartbeatStates']; presets: { id: string; name: string; broken?: string }[]
}> {
  const state = runtime.store.snapshot()
  const presets = await runtime.ctx.agentPresets.list().then(items => items.map(item => ({
    id: item.id,
    name: item.name ?? item.id,
    ...(item.broken ? { broken: item.broken } : {}),
  }))).catch(() => [])
  const sessions = state.sessions.map(item => ({ ...item, archived: runtime.agents.isArchived(item) }))
  return { companions: state.companions, channels: await runtime.channels.views(), pairings: state.pairings, sessions, heartbeatStates: state.heartbeatStates, presets }
}

function localDay(now: number): string { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function createId(prefix: string): string { return `${prefix}-${randomBytes(10).toString('hex')}` }
