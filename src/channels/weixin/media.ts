import { createDecipheriv } from 'node:crypto'
import type { PartnerInboundAttachment } from '../../channel-message.js'
import { PARTNER_MEDIA_MAX_BYTES, safeMediaName } from '../../channel-message.js'
import type { WeixinRawItem, WeixinCdnMedia } from './types.js'

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export async function receiveWeixinMedia(item: WeixinRawItem, signal?: AbortSignal): Promise<PartnerInboundAttachment | undefined> {
  if (item.type === 2 && item.image_item) {
    const image = item.image_item
    const data = await readMedia(image.media, image.aeskey, signal)
    if (!data) return undefined
    const mediaType = imageType(data)
    const extension = imageExtension(mediaType)
    return { kind: 'image', data, name: safeMediaName(image.filename || '微信图片', `微信图片${extension}`, extension), mediaType }
  }
  if (item.type === 4 && item.file_item) {
    const file = item.file_item
    const data = await readMedia(file.media, undefined, signal)
    if (!data) return undefined
    return { kind: 'file', data, name: safeMediaName(file.file_name || file.filename || '微信文件.bin'), ...(file.content_type ? { mediaType: file.content_type } : {}) }
  }
  return undefined
}

async function readMedia(media: WeixinCdnMedia | undefined, imageAesKey: string | undefined, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  if (!media) return undefined
  const url = media.full_url?.trim() || (media.encrypt_query_param ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : '')
  if (!url) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !trustedWeixinHost(parsed.hostname)) throw new Error('微信附件下载地址不可信')
  const response = await fetch(parsed, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`微信附件下载失败: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > PARTNER_MEDIA_MAX_BYTES) throw new Error('微信附件超过 64 MB 限制')
  const encrypted = Buffer.from(await response.arrayBuffer())
  if (encrypted.length > PARTNER_MEDIA_MAX_BYTES + 16) throw new Error('微信附件超过 64 MB 限制')
  const encodedKey = imageAesKey ? Buffer.from(imageAesKey, 'hex').toString('base64') : media.aes_key
  if (!encodedKey) return encrypted
  const key = decodeAesKey(encodedKey)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (plain.length > PARTNER_MEDIA_MAX_BYTES) throw new Error('微信附件超过 64 MB 限制')
  return plain
}

function decodeAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex')
  throw new Error('微信附件 AES 密钥格式无效')
}

function trustedWeixinHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host === 'wechat.com' || host.endsWith('.wechat.com')
}

function imageType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const value = Buffer.from(data)
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'image/jpeg'
  if (value.subarray(0, 6).toString('ascii') === 'GIF87a' || value.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new Error('微信图片格式不受支持')
}

function imageExtension(mediaType: string): string {
  return mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/gif' ? '.gif' : '.webp'
}
