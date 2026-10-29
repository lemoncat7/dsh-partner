export const PARTNER_MEDIA_MAX_BYTES = 64 * 1024 * 1024

export interface PartnerInboundAttachment {
  kind: 'image' | 'file'
  data: Uint8Array
  name: string
  mediaType?: string
}

export interface PartnerInboundMessage {
  sessionTitle?: string
  text: string
  attachments: PartnerInboundAttachment[]
}

export interface PartnerOutboundAttachment {
  contentHash?: string
  path: string
  name: string
  mediaType: string
  kind: 'image' | 'file'
}

export interface PartnerReply {
  idleContactOrigin?: {routeId:string;sessionId:string;messageId:string;userMessageId:string;policyRevision:number}
  chatParts?: import('./chat/protocol.js').ChatPart[]
  chatOriginRouteId?: string | null
  /** Freeze the direct source; never reroute a queued reply after account or room changes. */
  directSource?: { routeId: string; sessionId: string; accountId: string; baseUrl: string; targetId: string }

  /** Status-only delivery must suppress even previously queued attachment parts. */
  attachmentPolicy?: 'text-only'
  attachmentScope?: string
  text: string
  attachments: PartnerOutboundAttachment[]
}

export function safeMediaName(value: string, fallback = '微信附件.bin', defaultExtension = ''): string {
  const cleaned = value.replace(/[\\/\0-\x1f<>:"|?*]+/g, '_').trim().replace(/^\.+/, '').slice(0, 160)
  if (!cleaned) return fallback
  return defaultExtension && !cleaned.includes('.') ? `${cleaned}${defaultExtension}` : cleaned
}
