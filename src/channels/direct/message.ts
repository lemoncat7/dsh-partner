import type { DirectMessage } from './transport.js'

/** Extract references only. Downloading requires an approved peer at handoff. */
export function matrixMessage(event: any, sender: string, targetId?: string): DirectMessage | undefined {
  if (event.sender !== sender || event.type !== 'm.room.message' || event.content?.['m.relates_to']?.rel_type === 'm.replace' || typeof event.event_id !== 'string') return undefined
  const content = event.content ?? {}
  const message: DirectMessage = { id: event.event_id, sender, text: content.msgtype === 'm.text' && typeof content.body === 'string' ? content.body : '', ...(targetId ? { targetId } : {}) }
  if (Number.isFinite(event.origin_server_ts)) message.timestamp = event.origin_server_ts
  if (['m.image', 'm.file', 'm.audio', 'm.video'].includes(content.msgtype)) {
    message.media = [{ source: content.url ?? '', name: content.filename ?? content.body, mediaType: content.info?.mimetype, size: content.info?.size, encrypted: !!content.file }]
    if (typeof content.filename === 'string' && typeof content.body === 'string' && content.filename !== content.body) message.text = content.body
  }
  return message
}
