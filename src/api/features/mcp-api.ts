import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpService } from '../../mcp/service.js'
import { httpError, mutation, readObject, sendJson } from '../http.js'

export async function dispatchMcpApi(req: IncomingMessage, res: ServerResponse, parts: string[], service: McpService): Promise<boolean> {
  if (parts[0] !== 'mcp') return false
  const method = req.method ?? 'GET', id = parts[1]
  if (method === 'GET' && parts.length === 1) { sendJson(res, 200, service.catalog()); return true }
  if (method === 'GET' && id && parts.length === 3 && parts[2] === 'config') {
    res.setHeader('Cache-Control', 'no-store')
    sendJson(res, 200, await service.edit(id, new URL(req.url ?? '/', 'http://partner.local').searchParams.get('reveal') === '1'))
    return true
  }
  mutation(req)
  if (method === 'POST' && parts.length === 1) await service.save(await readObject(req))
  else if (method === 'POST' && id === 'import' && parts.length === 2) await service.import(await readObject(req))
  else if (method === 'POST' && id === 'bindings' && parts.length === 2) {
    const body = await readObject(req)
    if (typeof body.companionId !== 'string' || typeof body.serverId !== 'string' || typeof body.enabled !== 'boolean') throw httpError(400, 'MCP 授权参数无效')
    await service.bind(body.companionId, body.serverId, body.enabled)
  }
  else if (id && parts.length === 2 && method === 'PUT') await service.save(await readObject(req), id)
  else if (id && parts.length === 2 && method === 'DELETE') await service.remove(id)
  else if (id && parts.length === 3 && parts[2] === 'refresh' && method === 'POST') await service.refresh(id)
  else throw httpError(405, 'MCP 操作或请求方法无效')
  sendJson(res, 200, service.catalog())
  return true
}
