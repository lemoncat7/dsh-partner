import type { PushAdapter } from './push-domain.js'

export class PushSendError extends Error {
  constructor(message: string, readonly retryable = true) { super(message) }
}

/** Permit explicitly configured LAN servers, but never forward a device key
 * through redirects or put it in a URL/access log. TLS verification stays on. */
export const barkAdapter: PushAdapter = {
  async send(channel, deviceKey, payload, signal) {
    try {
      const response = await fetch(`${channel.baseUrl}/push`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: deviceKey, title: payload.title, body: payload.body,
          group: channel.group || 'DSH 伙伴', isArchive: '1',
          ...(channel.sound ? { sound: channel.sound } : {}), ...(channel.openUrl ? { url: channel.openUrl } : {}) }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new PushSendError(`Bark 服务返回 HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new PushSendError('Bark 响应为空', false)
      const parts: Uint8Array[] = []; let size = 0
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength
          if (size > 65_536) throw new PushSendError('Bark 响应过大，请检查服务器地址', false)
          parts.push(part.value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      let data: { code?: number }
      try { data = JSON.parse(Buffer.concat(parts).toString('utf8')) as typeof data }
      catch { throw new PushSendError('响应不是 Bark JSON，请检查反向代理和服务器地址', false) }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PushSendError('响应不是 Bark JSON，请检查反向代理和服务器地址', false)
      if (data.code !== 200) throw new PushSendError(`Bark 未接受通知（code ${typeof data.code === 'number' ? data.code : '无效'}），请检查设备 Key`, data.code === 429 || (typeof data.code === 'number' && data.code >= 500))
    } catch (error) {
      if (error instanceof PushSendError) throw error
      const code = (error as { cause?: { code?: string } })?.cause?.code ?? ''
      if (/CERT|TLS|SSL/.test(code)) throw new PushSendError('Bark TLS 证书校验失败，请检查证书及域名', false)
      if (code === 'ENOTFOUND') throw new PushSendError('无法解析 Bark 域名，请检查服务端 DNS')
      if (code === 'ECONNREFUSED') throw new PushSendError('Bark 连接被拒绝，请检查端口和反向代理')
      throw new PushSendError('Bark 请求超时或网络不可达，请检查 DSH 服务端到该地址的连接')
    }
  },
}
