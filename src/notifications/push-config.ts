import { createHash, randomUUID } from 'node:crypto'
import { httpError } from '../api/http.js'
import type { PushChannel, PushTarget } from './push-domain.js'

const text = (value: unknown, label: string, max: number, fallback = ''): string => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `${label}无效，最多 ${max} 字符`)
  return value.trim()
}
export function pushUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw httpError(400, '请填写完整的 http:// 或 https:// 服务器地址') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw httpError(400, '服务器地址不支持账号、查询参数或片段')
  return url.toString().replace(/\/+$/, '')
}
export function parsePushChannel(raw: Record<string, unknown>, companionId: string, previous?: PushChannel) {
  if (raw.platform !== undefined && raw.platform !== 'bark') throw httpError(400, '暂不支持该推送平台')
  const baseUrl = pushUrl(text(raw.baseUrl, '服务器地址', 4096))
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 50) throw httpError(400, '请配置 1–50 个发送目标')
  const secrets: Array<{ id: string; key: string }> = []
  const seen = new Set<string>(), ids = new Set<string>()
  const targets: PushTarget[] = raw.targets.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw httpError(400, '发送目标格式无效')
    const item = value as Record<string, unknown>
    const old = previous?.targets.find(t => t.id === item.id)
    if (item.id && !old) throw httpError(400, '发送目标已变化，请重新打开配置')
    const id = old?.id ?? `target-${randomUUID()}`
    if (ids.has(id)) throw httpError(400, '发送目标重复'); ids.add(id)
    const key = text(item.key, 'Device Key', 512)
    if (!key && !old) throw httpError(400, '请填写设备 Key')
    if (key && !/^[A-Za-z0-9_-]+$/.test(key)) throw httpError(400, '设备 Key 只能包含字母、数字、下划线和连字符；完整地址请使用粘贴导入')
    const fingerprint = key ? createHash('sha256').update(key).digest('hex') : old!.fingerprint
    if (seen.has(fingerprint)) throw httpError(400, '同一服务器中不能重复添加相同设备 Key'); seen.add(fingerprint)
    const credentialId = key ? `push-${randomUUID()}` : old!.credentialId
    if (key) secrets.push({ id: credentialId, key })
    return { id, name: text(item.name, '设备名称', 80) || '我的设备', enabled: item.enabled !== false, credentialId, fingerprint }
  })
  const openUrl = text(raw.openUrl, '点击跳转地址', 4096)
  if (openUrl) {
    let url: URL
    try { url = new URL(openUrl) } catch { throw httpError(400, '点击跳转地址无效') }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw httpError(400, '点击跳转地址只支持 HTTP/HTTPS，不能包含账号密码')
  }
  const sound = text(raw.sound, '提示音', 80)
  if (sound && !/^[a-zA-Z0-9_-]+$/.test(sound)) throw httpError(400, '提示音名称无效')
  const now = Date.now()
  const channel: PushChannel = {
    id: previous?.id ?? `push-${randomUUID()}`, companionId, platform: 'bark', name: text(raw.name, '渠道名称', 80) || 'Bark',
    baseUrl, enabled: raw.enabled !== false, revision: (previous?.revision ?? 0) + 1,
    targets, notifyProblems: raw.notifyProblems === true, content: raw.content === 'title' ? 'title' : 'summary',
    group: text(raw.group, '通知分组', 80), sound, openUrl, createdAt: previous?.createdAt ?? now, updatedAt: now,
  }
  return { channel, secrets }
}
