import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { PartnerOutboundAttachment } from '../../channel-message.js'
import { PARTNER_MEDIA_MAX_BYTES } from '../../channel-message.js'
import type { GetUpdatesResponse, QrCodeData, QrCodeStatusData } from './types.js'

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CLIENT_VERSION = String((0 << 16) | (1 << 8) | 0)
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export class WeixinApi {
  constructor(
    private readonly baseUrl = WEIXIN_DEFAULT_BASE_URL,
    private readonly botToken = '',
  ) {}

  async getQrCode(signal?: AbortSignal): Promise<QrCodeData> {
    return unwrap<QrCodeData>(await this.get('ilink/bot/get_bot_qrcode', { bot_type: '3' }, false, signal), 'qrcode')
  }

  async getQrCodeStatus(qrcode: string, signal?: AbortSignal): Promise<QrCodeStatusData> {
    return unwrap<QrCodeStatusData>(await this.get('ilink/bot/get_qrcode_status', { qrcode }, false, signal), 'status')
  }

  async getUpdates(buffer: string, timeoutMs: number, signal: AbortSignal): Promise<GetUpdatesResponse> {
    return this.post<GetUpdatesResponse>('ilink/bot/getupdates', {
      get_updates_buf: buffer,
      base_info: baseInfo(),
    }, timeoutMs + 10_000, signal)
  }

  async sendText(toUserId: string, text: string, contextToken: string | undefined, signal?: AbortSignal): Promise<void> {
    const response = await this.post<{ ret?: number; errcode?: number; errmsg?: string }>('ilink/bot/sendmessage', {
      msg: {
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: baseInfo(),
    }, 30_000, signal)
    if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
      throw new Error(`微信发送失败: ${response.errmsg || `ret=${response.ret ?? 0}, errcode=${response.errcode ?? 0}`}`)
    }
  }

  async sendAttachment(toUserId: string, attachment: PartnerOutboundAttachment, contextToken: string | undefined, signal?: AbortSignal): Promise<void> {
    const info = await stat(attachment.path)
    if (!info.isFile()) throw new Error('微信待发送附件不是普通文件')
    if (info.size > PARTNER_MEDIA_MAX_BYTES) throw new Error('微信待发送附件超过 64 MB 限制')
    const plain = await readFile(attachment.path)
    const key = randomBytes(16)
    const fileKey = randomBytes(16).toString('hex')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const upload = await this.post<UploadResponse>('ilink/bot/getuploadurl', {
      filekey: fileKey,
      media_type: attachment.kind === 'image' ? 1 : 3,
      to_user_id: toUserId,
      rawsize: plain.length,
      rawfilemd5: createHash('md5').update(plain).digest('hex'),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: key.toString('hex'),
      base_info: baseInfo(),
    }, 30_000, signal)
    assertSuccess(upload, '微信附件上传地址申请失败')
    const uploadUrl = upload.upload_full_url?.trim() || (upload.upload_param ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(fileKey)}` : '')
    if (!uploadUrl) throw new Error('微信附件上传地址缺失')
    const parsedUploadUrl = new URL(uploadUrl)
    if (parsedUploadUrl.protocol !== 'https:' || !trustedWeixinHost(parsedUploadUrl.hostname)) throw new Error('微信附件上传地址不可信')
    const encryptedParam = await uploadCdn(parsedUploadUrl.toString(), encrypted, signal)
    const media = { encrypt_query_param: encryptedParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }
    const item = attachment.kind === 'image'
      ? { type: 2, image_item: { content_type: attachment.mediaType, media, mid_size: encrypted.length } }
      : { type: 4, file_item: { media, file_name: basename(attachment.name), len: String(plain.length) } }
    const response = await this.post<{ ret?: number; errcode?: number; errmsg?: string }>('ilink/bot/sendmessage', {
      msg: {
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: baseInfo(),
    }, 30_000, signal)
    assertSuccess(response, '微信附件发送失败')
  }

  private async get(path: string, query: Record<string, string>, authenticated: boolean, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await fetch(url, { headers: this.headers(authenticated), ...(signal ? { signal } : {}) })
    return responseJson(response, path)
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/${path}`, {
      method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal: requestSignal,
    })
    return responseJson(response, path) as Promise<T>
  }

  private headers(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'ilink-app-id': 'bot',
      'ilink-app-clientversion': CLIENT_VERSION,
    }
    if (authenticated) {
      const uin = randomBytes(4).readUInt32BE(0).toString()
      headers['content-type'] = 'application/json'
      headers.authorizationtype = 'ilink_bot_token'
      headers.authorization = `Bearer ${this.botToken.trim()}`
      headers['x-wechat-uin'] = Buffer.from(uin).toString('base64')
    }
    return headers
  }
}

interface UploadResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  upload_full_url?: string
}

async function uploadCdn(url: string, encrypted: Buffer, signal?: AbortSignal): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(encrypted), ...(signal ? { signal } : {}) })
      if (!response.ok) throw new Error(`CDN HTTP ${response.status}`)
      const parameter = response.headers.get('x-encrypted-param')?.trim()
      if (!parameter) throw new Error('CDN 响应缺少 x-encrypted-param')
      return parameter
    } catch (error) {
      lastError = error
      if (signal?.aborted || attempt === 3) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error('微信 CDN 上传失败')
}

function assertSuccess(response: { ret?: number; errcode?: number; errmsg?: string }, fallback: string): void {
  if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) throw new Error(`${fallback}: ${response.errmsg || response.errcode || response.ret}`)
}

function trustedWeixinHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host === 'wechat.com' || host.endsWith('.wechat.com')
}

function baseInfo(): Record<string, string> {
  return { channel_version: '0.1.0', bot_agent: 'DSH-Partner/0.1.0' }
}

async function responseJson(response: Response, path: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}

function unwrap<T extends object>(value: unknown, required: keyof T): T {
  const direct = value as T
  if (direct && direct[required] !== undefined) return direct
  const wrapped = value as { data?: T }
  if (wrapped?.data && wrapped.data[required] !== undefined) return wrapped.data
  throw new Error(`微信接口响应缺少 ${String(required)}`)
}
