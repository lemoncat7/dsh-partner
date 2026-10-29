import type { DirectMessage } from '../direct/transport.js'
import type { DirectMedia } from '../direct/media.js'

export function qqId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return /^[1-9]\d{4,15}$/.test(id) ? id : undefined
}

/** Never interpret raw CQ text as an instruction to send or fetch a resource. */
export function oneBotMessage(raw: any, accountId: string, targetId = ''): DirectMessage | undefined {
  if (!raw || raw.post_type !== 'message' || raw.message_type !== 'private' || raw.sub_type !== 'friend') return
  const sender = qqId(raw.user_id)
  if (!sender || sender === accountId || qqId(raw.self_id) !== accountId || targetId && sender !== targetId) return
  const id = raw.message_id
  if (!['string', 'number'].includes(typeof id) || !String(id) || String(id).length > 128) return
  const text: string[] = [], media: DirectMedia[] = []
  if (typeof raw.message === 'string') text.push(raw.message.slice(0, 100000))
  else if (Array.isArray(raw.message)) for (const part of raw.message.slice(0, 128)) {
    if (part?.type === 'text' && typeof part.data?.text === 'string') text.push(part.data.text.slice(0, 100000))
    else if (part?.type === 'face') text.push(`[QQ 表情 ${String(part.data?.id ?? '').slice(0, 20)}]`)
    else if (['image', 'record', 'video', 'file'].includes(part?.type)) {
      const data = part.data ?? {}
      media.push({ source: typeof data.url === 'string' ? data.url : '', ...(typeof data.name === 'string' ? { name: data.name } : {}), ...(typeof data.file_size === 'number' ? { size: data.file_size } : {}) })
    }
  }
  return { id: `qq:${accountId}:${sender}:${id}`, sender, targetId: sender, text: text.join('').slice(0, 100000), ...(media.length ? { media } : {}), ...(Number.isFinite(raw.time) ? { timestamp: raw.time * 1000 } : {}) }
}
