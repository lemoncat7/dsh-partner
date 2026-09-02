import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PartnerStore } from '../../store.js'
import type { SkillService } from '../../skills/service.js'
import type { TaskBoardService } from '../../tasks/service.js'
import type { PartnerCollaborationService } from '../../collaboration/service.js'
import type { PartnerSchedulerService } from '../../scheduler/service.js'
import { mutation, readObject, sendJson } from '../http.js'

export interface PartnerWorkspaceApiRuntime {
  store: PartnerStore
  skills: SkillService
  tasks: TaskBoardService
  collaboration: PartnerCollaborationService
  scheduler: PartnerSchedulerService
}

export async function dispatchPartnerWorkspaceApi(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  runtime: PartnerWorkspaceApiRuntime,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  if (segments[0] === 'skills') {
    if (method === 'GET' && segments.length === 1) {
      const state = runtime.store.snapshot()
      sendJson(res, 200, { installed: state.skills, bindings: state.skillBindings, sources: state.skillMarketSources })
      return true
    }
    if (method === 'GET' && segments[1] === 'market' && segments.length === 2) {
      sendJson(res, 200, await runtime.skills.market(url.searchParams.get('refresh') === '1'))
      return true
    }
    if (method === 'POST' && segments[1] === 'local' && segments.length === 2) {
      mutation(req); const body = await readObject(req)
      sendJson(res, 201, await runtime.skills.installLocal(String(body.document ?? ''), typeof body.id === 'string' ? body.id : undefined))
      return true
    }
    if (method === 'POST' && segments[1] === 'market' && segments[2] === 'install' && segments.length === 3) {
      mutation(req); const body = await readObject(req)
      sendJson(res, 201, await runtime.skills.installMarket(String(body.sourceId ?? ''), String(body.entryId ?? '')))
      return true
    }
    if (method === 'DELETE' && segments[1] && segments.length === 2) {
      mutation(req); await runtime.skills.uninstall(segments[1]); sendJson(res, 204, undefined); return true
    }
  }
  if (segments[0] === 'skill-markets') {
    if (method === 'POST' && segments.length === 1) { mutation(req); sendJson(res, 201, await runtime.skills.addMarketSource(await readObject(req))); return true }
    if (method === 'DELETE' && segments[1] && segments.length === 2) { mutation(req); await runtime.skills.removeMarketSource(segments[1]); sendJson(res, 204, undefined); return true }
  }
  if (segments[0] === 'companions' && segments[1] && segments[2] === 'skills' && segments[3] && method === 'PUT' && segments.length === 4) {
    mutation(req); const body = await readObject(req)
    if (typeof body.enabled !== 'boolean') throw new Error('enabled must be boolean')
    await runtime.skills.setBinding(segments[1], segments[3], body.enabled)
    sendJson(res, 200, { ok: true }); return true
  }
  if (segments[0] === 'tasks') {
    if (method === 'GET' && segments.length === 1) { sendJson(res, 200, runtime.tasks.snapshot()); return true }
    if (method === 'POST' && segments.length === 1) { mutation(req); sendJson(res, 201, await runtime.tasks.create(await readObject(req), { kind: 'user' })); return true }
    const id = segments[1]
    if (id && method === 'PUT' && segments.length === 2) { mutation(req); sendJson(res, 200, await runtime.tasks.update(id, await readObject(req), { kind: 'user' })); return true }
    if (id && method === 'DELETE' && segments.length === 2) { mutation(req); await runtime.tasks.remove(id); sendJson(res, 204, undefined); return true }
    if (id && method === 'POST' && segments[2] === 'comment' && segments.length === 3) {
      mutation(req); const body = await readObject(req); await runtime.tasks.comment(id, String(body.message ?? ''), { kind: 'user' }); sendJson(res, 200, { ok: true }); return true
    }
    if (id && method === 'POST' && segments[2] === 'delegate' && segments.length === 3) {
      mutation(req); const body = await readObject(req)
      sendJson(res, 200, await runtime.collaboration.delegate({
        taskId: id, fromCompanionId: String(body.fromCompanionId ?? ''), to: String(body.to ?? ''), request: String(body.request ?? ''),
      })); return true
    }
  }
  if (segments[0] === 'collaboration' && method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { companions: runtime.collaboration.directory(), delegations: runtime.store.snapshot().delegations }); return true
  }
  if (segments[0] === 'schedules') {
    if (method === 'GET' && segments.length === 1) { sendJson(res, 200, { schedules: runtime.scheduler.list(), runs: runtime.store.snapshot().executionRuns }); return true }
    if (method === 'POST' && segments.length === 1) { mutation(req); sendJson(res, 201, await runtime.scheduler.create(await readObject(req))); return true }
    const id = segments[1]
    if (id && method === 'PUT' && segments.length === 2) { mutation(req); sendJson(res, 200, await runtime.scheduler.update(id, await readObject(req))); return true }
    if (id && method === 'DELETE' && segments.length === 2) { mutation(req); await runtime.scheduler.remove(id); sendJson(res, 204, undefined); return true }
    if (id && method === 'POST' && segments[2] === 'trigger' && segments.length === 3) {
      mutation(req)
      void runtime.scheduler.trigger(id).catch(() => {})
      sendJson(res, 202, { accepted: true })
      return true
    }
  }
  return false
}
