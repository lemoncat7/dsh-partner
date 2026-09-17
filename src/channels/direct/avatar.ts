import type { DirectConfig } from './transport.js'

export interface AvatarImage { bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }

/** Only updates the authenticated account. No caller-controlled user id or remote image fetch. */
export async function updateDirectAvatar(config: DirectConfig, token: string, accountId: string, image: AvatarImage, signal: AbortSignal, guard: () => void): Promise<{ accountId: string; avatar: string }> {
  const request = async (path: string, method = 'GET', body?: BodyInit, contentType?: string): Promise<any> => {
    signal.throwIfAborted(); guard()
    const response = await fetch(config.baseUrl + path, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
      ...(body === undefined ? {} : { body }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`头像请求失败（HTTP ${response.status}），未确认更新成功`) }
    if (response.status === 204) return {}
    const reader = response.body?.getReader()
    if (!reader) return {}
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        size += part.value.length
        if (size > 64 * 1024) { await reader.cancel(); throw new Error('头像接口响应超过限制') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }
  const matrix = config.platform === 'matrix'
  const who = await request(matrix ? '/_matrix/client/v3/account/whoami' : '/api/v4/users/me')
  if ((matrix ? who.user_id : who.id) !== accountId) throw new Error('渠道凭据账号已变化，拒绝修改头像，请重新配置渠道')
  const user = encodeURIComponent(accountId)
  if (matrix) {
    const uploaded = await request('/_matrix/media/v3/upload', 'POST', new Uint8Array(image.bytes), image.mediaType)
    if (typeof uploaded.content_uri !== 'string' || !/^mxc:\/\/[^\s/]+\/[^\s/?#]+$/.test(uploaded.content_uri)) throw new Error('Matrix 未返回有效媒体地址，头像尚未修改')
    await request(`/_matrix/client/v3/profile/${user}/avatar_url`, 'PUT', JSON.stringify({ avatar_url: uploaded.content_uri }), 'application/json')
    return { accountId, avatar: uploaded.content_uri }
  }
  const form = new FormData()
  form.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }), image.mediaType === 'image/png' ? 'avatar.png' : 'avatar.jpg')
  await request(`/api/v4/users/${user}/image`, 'POST', form)
  return { accountId, avatar: `${config.baseUrl}/api/v4/users/${user}/image` }
}
