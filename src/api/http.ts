import type { IncomingMessage, ServerResponse } from 'node:http'
import { object } from '../domain.js'

const MAX_BODY_BYTES = 1_048_576

export function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && host !== undefined && new URL(origin).host !== host) throw httpError(403, 'cross-origin Partner API access is forbidden')
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'same-site' && site !== 'none') throw httpError(403, 'cross-site Partner API access is forbidden')
}
export function mutation(req: IncomingMessage): void {
  if (req.headers['x-dsh-partner-request'] !== '1') throw httpError(403, 'missing Partner mutation request header')
}

export async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw httpError(413, 'request body is too large')
    chunks.push(buffer)
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), 'request body') }
  catch (error) { if (error instanceof HttpError) throw error; throw httpError(400, error instanceof Error ? error.message : 'request body is invalid') }
}

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
export function httpError(status: number, message: string): HttpError { return new HttpError(status, message) }
export function sendError(res: ServerResponse, error: unknown): void {
  const explicit = error instanceof HttpError ? error.status : typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500
  sendJson(res, explicit, { error: error instanceof Error ? error.message : String(error) })
}
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(status === 204 ? undefined : JSON.stringify(value))
}
