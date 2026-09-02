import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { DEFAULT_AUTOMATION, normalizeAutomation, normalizeCompanionDraft, text, type ChannelView, type Companion } from './domain.js'
import { PartnerStore } from './store.js'
import { PartnerCredentialVault } from './credentials.js'
import { ChannelManager, requiredCompanion } from './channels/manager.js'
import { WeixinLoginManager } from './channels/weixin/login.js'
import { memoryScope, PartnerAgentRuntime } from './agent-runtime.js'
import { PartnerMemoryStore } from './memory-store.js'
import { HeartbeatScheduler } from './heartbeat.js'
import { DailyReviewScheduler } from './daily-review.js'
import { PartnerConcernStore } from './concern-store.js'
import type { SkillService } from './skills/service.js'
import type { TaskBoardService } from './tasks/service.js'
import type { PartnerCollaborationService } from './collaboration/service.js'
import type { PartnerSchedulerService } from './scheduler/service.js'
import { dispatchPartnerWorkspaceApi } from './api/features/workspace-api.js'
import { assertSameOrigin, httpError, mutation, readObject, sendError, sendJson } from './api/http.js'

export interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
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
  collaboration: PartnerCollaborationService
  scheduler: PartnerSchedulerService
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
  if (method === 'GET' && segments[0] === 'health') return sendJson(res, 200, { ok: true, service: 'dsh-partner', schemaVersion: 11 })
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
      const body = await readObject(req)
      const draft = normalizeCompanionDraft(body.companion)
      const now = Date.now()
      const companion: Companion = { ...draft, automation: structuredClone(DEFAULT_AUTOMATION), id: createId('companion'), createdAt: now, updatedAt: now }
      await runtime.store.update(state => { state.companions.push(companion) })
      return sendJson(res, 201, companion)
    }
    const id = segments[1]
    if (id !== undefined && method === 'PUT' && segments.length === 2) {
      mutation(req)
      const previous = requiredCompanion(runtime.store, id)
      const draft = normalizeCompanionDraft((await readObject(req)).companion)
      const next: Companion = { ...draft, automation: previous.automation, id, createdAt: previous.createdAt, updatedAt: Date.now() }
      await runtime.agents.reloadCompanion(id)
      await runtime.store.update(state => { state.companions = state.companions.map(item => item.id === id ? next : item) })
      return sendJson(res, 200, next)
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const current = runtime.store.snapshot()
      if (current.channels.some(item => item.companionId === id)) throw httpError(409, '请先删除或换绑该伙伴的微信渠道')
      if (current.companions.length <= 1) throw httpError(409, '至少保留一个伙伴')
      if (current.executionRuns.some(item => item.ownerCompanionId === id && item.status === 'running')) throw httpError(409, '伙伴仍有正在执行的临时任务，请等待完成后再删除')
      await runtime.agents.resetCompanion(id)
      await runtime.store.update(state => {
        state.companions = state.companions.filter(item => item.id !== id)
        state.skillBindings = state.skillBindings.filter(item => item.companionId !== id)
        state.schedules = state.schedules.filter(item => item.companionId !== id)
        for (const task of state.tasks) if (task.assigneeCompanionId === id) {
          delete task.assigneeCompanionId
          task.revision += 1
          task.updatedAt = Date.now()
        }
      })
      await runtime.memory.clear(id)
      await runtime.concerns.clear(id)
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
      if (method === 'GET' && segments.length === 3) {
        const state = runtime.store.snapshot()
        const routes = state.sessions.filter(item => item.companionId === id)
        const scopes = routes.map(item => memoryScope(item.channelId, item.userId))
        const [memories, reflections, profiles] = await Promise.all([
          runtime.memory.recentMemories(id, 100), runtime.memory.recentReflections(id, 30), runtime.memory.profileSnapshots(id, scopes),
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
      if (method === 'POST' && segments.length === 3) {
        mutation(req)
        const body = await readObject(req)
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 800) : ''
        return sendJson(res, 201, await runtime.concerns.createExplicit(id, '*', text(body.subject, 'subject', 300), reason))
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
    if (id !== undefined && method === 'POST' && segments[2] === 'heartbeat' && segments[3] === 'trigger' && segments.length === 4) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const body = await readObject(req)
      const concernId = typeof body.concernId === 'string' ? body.concernId.trim().slice(0, 160) : undefined
      return sendJson(res, 200, await runtime.heartbeat.trigger(id, { manual: true, ...(concernId ? { concernId } : {}) }))
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

function createId(prefix: string): string { return `${prefix}-${randomBytes(10).toString('hex')}` }
function localDay(now: number): string { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
