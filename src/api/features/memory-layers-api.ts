import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PartnerMemoryStore } from '../../memory-store.js'
import { text } from '../../domain.js'
import { mutation, readObject, sendJson, httpError } from '../http.js'
import {validCalendarDay} from '../../memory-calendar.js'

/** Called only after the parent route's same-origin and companion checks. */
export async function dispatchMemoryLayersApi(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[], memory: PartnerMemoryStore, companionId: string): Promise<boolean> {
  const section = segments[3]
  if (!['layers', 'history', 'timeline', 'experiences', 'jobs', 'persona'].includes(section ?? '')) return false
  const scopeId = text(url.searchParams.get('scopeId'), 'scopeId', 500)
  if (section === 'persona' && segments.length === 4 && req.method === 'POST') {
    mutation(req)
    const body = await readObject(req)
    if (body.action !== 'refresh' && body.action !== 'correct') throw httpError(400, 'Invalid persona action')
    await memory.requestPersona(companionId, scopeId, text(body.version, 'version', 80),
      body.action === 'correct' ? text(body.paragraphId, 'paragraphId', 80) : undefined,
      body.action === 'correct' && body.correction ? text(body.correction, 'correction', 500) : undefined)
    sendJson(res, 200, {ok: true}); return true
  }
  if (req.method === 'GET' && segments.length === 4 && section === 'layers') {
    sendJson(res, 200, await memory.memoryLayers(companionId, scopeId)); return true
  }
  if (req.method === 'GET' && segments.length === 4 && section === 'history') {
    const q=url.searchParams.get('q')?.trim()
    if(q) {sendJson(res,200,await memory.searchHistory(companionId,scopeId,text(q,'q',300),12));return true}
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Date.now() + 1
    const day=url.searchParams.get('day') ?? undefined
    if (!Number.isFinite(before)) throw httpError(400, 'Invalid history cursor')
    if(day!==undefined&&!validCalendarDay(day))throw httpError(400,'日期无效')
    sendJson(res, 200, await memory.history(companionId, scopeId, before, 30, url.searchParams.get('beforeId') ?? '\uffff',day)); return true
  }
  if (req.method === 'GET' && segments.length === 4 && section === 'timeline') {
    const through=url.searchParams.get('through')??undefined
    if(through!==undefined&&!validCalendarDay(through))throw httpError(400,'日期无效')
    sendJson(res,200,await memory.historyTimeline(companionId,scopeId,Date.now(),through));return true
  }
  const id = segments[4]
  if (section === 'experiences' && id && req.method === 'POST' && segments.length === 5) {
    mutation(req)
    const body = await readObject(req)
    if (body.action !== 'approved' && body.action !== 'rejected') throw httpError(400, 'Invalid review action')
    await memory.reviewExperience(companionId, scopeId, id, text(body.version, 'version', 80), body.action)
    sendJson(res, 200, { ok: true }); return true
  }
  if (section === 'experiences' && id && req.method === 'GET' && segments.length === 5) {
    sendJson(res, 200, { document: await memory.exportExperience(companionId, scopeId, id) }); return true
  }
  if (section === 'jobs' && id && req.method === 'POST' && segments.length === 5) {
    mutation(req)
    await memory.retryJob(companionId, scopeId, id)
    sendJson(res, 200, { ok: true }); return true
  }
  throw httpError(404, 'Memory operation not found')
}
