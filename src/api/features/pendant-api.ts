import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { PartnerInboxStore } from '../../notifications/store.js'
import { mutation, readObject, sendJson, httpError } from '../http.js'

let renderer: Promise<Buffer> | undefined
export async function dispatchPendantApi(req: IncomingMessage, res: ServerResponse, segments: string[], inbox: PartnerInboxStore): Promise<boolean> {
  if (segments[0] !== 'pendant') return false
  if (req.method === 'GET' && segments.length === 2 && segments[1] === 'renderer.js') {
    // Fixed packaged asset only: no client-controlled filesystem path or CDN.
    renderer ??= readFile(new URL('../../pendant-renderer.js', import.meta.url)).catch(error => { renderer = undefined; throw error })
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(await renderer)
    return true
  }
  if (req.method === 'GET' && segments.length === 2 && segments[1] === 'inbox') {
    res.setHeader('etag', inbox.etag)
    if (req.headers['if-none-match'] === inbox.etag) { res.statusCode = 304; res.end(); return true }
    sendJson(res, 200, inbox.snapshot()); return true
  }
  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'read') {
    mutation(req)
    const { ids } = await readObject(req)
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(id => typeof id === 'string' && id.length <= 300)) throw httpError(400, 'invalid notice IDs')
    inbox.markRead(ids)
    sendJson(res, 200, inbox.snapshot())
    return true
  }
  throw httpError(404, 'unknown pendant endpoint')
}
