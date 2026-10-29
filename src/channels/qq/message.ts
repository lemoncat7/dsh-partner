import { qqSettings, validQqId, type QqSettings } from './settings.js'
import type { DirectMessage } from '../direct/transport.js'
import type { DirectMedia } from '../direct/media.js'

export function qqId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : ''
  return validQqId(id) ? id : undefined
}

/** Never interpret raw CQ text as an instruction to send or fetch a resource. */
export function oneBotMessage(raw: any, accountId: string, targetId = '', settings?: QqSettings): DirectMessage | undefined {
  const policy=qqSettings(settings)
  if (!raw || raw.post_type!=='message' || !['private','group'].includes(raw.message_type)) return
  const realSender=qqId(raw.user_id),groupId=raw.message_type==='group'?qqId(raw.group_id):undefined
  if (!realSender || realSender===accountId || qqId(raw.self_id)!==accountId) return
  if (raw.message_type==='private' && (!policy.privateReplies || raw.sub_type!=='friend' || targetId&&targetId!==realSender)) return
  const mentioned=Array.isArray(raw.message)&&raw.message.some((p:any)=>p?.type==='at'&&String(p.data?.qq)===accountId)
  const autonomous=!!groupId&&policy.autonomousGroupIds.includes(groupId)
  if (raw.message_type==='group') {
    if (raw.anonymous || !groupId || !policy.groupReplies || !policy.groupIds.includes(groupId) || targetId&&targetId!==`group:${groupId}`) return
    if (policy.groupTrigger==='mention'&&!mentioned&&!autonomous)return
  }
  const sender=groupId?`group:${groupId}:${realSender}`:realSender
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
  return { ...(Number.isFinite(raw._partnerReceivedAt)?{receivedAt:raw._partnerReceivedAt}:{}), senderName:String(raw.sender?.nickname||realSender).slice(0,80),...(groupId?{qqGroup:{groupId,userId:realSender,senderName:String(raw.sender?.card||raw.sender?.nickname||realSender).slice(0,80),mentioned,autonomous}}:{}),id: `qq:${accountId}:${sender}:${id}`, sender, targetId: groupId?`group:${groupId}`:sender, text: text.join('').slice(0, 100000), ...(media.length ? { media } : {}), ...(Number.isFinite(raw.time) ? { timestamp: raw.time * 1000 } : {}) }
}
