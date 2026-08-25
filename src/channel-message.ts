export const PARTNER_MEDIA_MAX_BYTES = 64 * 1024 * 1024

export interface PartnerInboundAttachment {
  kind: 'image' | 'file'
  data: Uint8Array
  name: string
  mediaType?: string
}

export interface PartnerInboundMessage {
  text: string
  attachments: PartnerInboundAttachment[]
}

export interface PartnerOutboundAttachment {
  path: string
  name: string
  mediaType: string
  kind: 'image' | 'file'
}

export interface PartnerReply {
  text: string
  attachments: PartnerOutboundAttachment[]
}

export function safeMediaName(value: string, fallback = '微信附件.bin', defaultExtension = ''): string {
  const cleaned = value.replace(/[\\/\0-\x1f<>:"|?*]+/g, '_').trim().replace(/^\.+/, '').slice(0, 160)
  if (!cleaned) return fallback
  return defaultExtension && !cleaned.includes('.') ? `${cleaned}${defaultExtension}` : cleaned
}
