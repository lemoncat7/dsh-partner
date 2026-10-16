import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PushService } from '../../notifications/push-service.js'
import { httpError, mutation, readObject, sendJson } from '../http.js'

export async function dispatchPushApi(req: IncomingMessage, res: ServerResponse, segments: string[], push: PushService): Promise<boolean> {
  if (segments[0] !== 'push-channels') return false
  const id = segments[1], method = req.method ?? 'GET'
  if (method === 'GET' && !id) { sendJson(res, 200, push.views()); return true }
  if (method === 'GET' && id && segments[2] === 'deliveries' && segments.length === 3) { sendJson(res, 200, push.deliveries(id)); return true }
  mutation(req)
  if (method === 'DELETE' && id && segments[2] === 'deliveries' && segments.length === 3) { await push.clearHistory(id); sendJson(res, 200, { ok: true }); return true }
  if ((method === 'POST' && segments.length === 1) || (method === 'PUT' && id && segments.length === 2)) {
    const body = await readObject(req)
    if (typeof body.companionId !== 'string') throw httpError(400, '请选择所属伙伴')
    sendJson(res, id ? 200 : 201, await push.save(body.companionId, body, id)); return true
  }
  if (method === 'DELETE' && id && segments.length === 2) { await push.remove(id); sendJson(res, 200, { ok: true }); return true }
  if (method === 'POST' && id && segments[2] === 'test' && segments.length === 3) {
    const body = await readObject(req)
    if (typeof body.targetId !== 'string') throw httpError(400, '请选择测试目标')
    await push.test(id, body.targetId); sendJson(res, 200, { ok: true, message: 'Bark 服务端已接受，请检查设备通知；这不代表设备已收到。' }); return true
  }
  if (method === 'POST' && id && segments[2] === 'deliveries' && segments[3] && segments[4] === 'retry' && segments.length === 5) {
    await push.retry(id, segments[3]); sendJson(res, 200, { ok: true }); return true
  }
  throw httpError(404, '推送管理接口不存在')
}
