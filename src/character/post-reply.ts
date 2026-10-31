import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import { affectionEnabled, affectionProgress } from './affection.js'
import { affectionAudienceAllowed } from './affection-adapter.js'
import { idleContactRouteAllowed } from './idle-contact.js'
import { isSleeping } from './sleep.js'

/** Persist misses too: one opportunity per delivered user turn, including after restart. */
export interface PostReplyOpportunity {
  userMessageId: string
  sessionId: string
  policyRevision: number
  deliveredAt: number
  dueAt: number
  expiresAt: number
  probability: number
  depth?: number
  status: 'pending' | 'missed' | 'claimed' | 'cancelled'
}
export const MAX_ACTIVITY_CHAIN = 5
export function postReplyProbability(companion: Companion, depth = 0): number {
  if(depth >= MAX_ACTIVITY_CHAIN)return 0
  const base = affectionEnabled(companion) ? 0.45 + 0.35 * affectionProgress(companion.affection).score / 100 : 0.45
  return base * 0.5 ** Math.max(0,depth)
}
/** Silence without any actual activity stops the chain; discovery alone isn't activity. */
export function completedActivityDidWork(events:readonly SessionEvent[]):boolean {
 const silent=events.some(e=>(e.type==='tool/call'||e.type==='tool/ptc-dispatch-start'||e.type==='tool/ptc-dispatch')&&e.data.name==='partner_activity_finish')
 return events.some(e=>{
  if(e.type==='assistant/message')return !silent && !e.data.interrupted && !e.data.message.content.some(b=>b.type==='tool-call') && e.data.message.content.some(b=>b.type==='text'&&b.text.trim())
  if(e.type!=='tool/result'&&e.type!=='tool/ptc-dispatch')return false
  if(e.type==='tool/result'?e.data.message.isError:e.data.isError)return false
  const meta=e.data.meta as {kind?:string;parts?:unknown[];delivered?:boolean}|undefined
  if(meta?.kind==='partner-chat-v1')return meta.delivered===true||!!meta.parts?.length
  const call=e.type==='tool/ptc-dispatch'?e:events.find(c=>c.type==='tool/call'&&c.data.callId===e.data.message.toolCallId)
  if(!call||(call.type!=='tool/call'&&call.type!=='tool/ptc-dispatch'))return false
  let name=call.data.name,args=call.data.arguments
  try{
   let input=typeof args==='string'?JSON.parse(args):args as Record<string,unknown>
   if(name==='partner_tools'){
    if(input?.action!=='call')return false
    name=String(input.name);input=JSON.parse(String(input.argumentsJson))
   }
   if(['partner_activity_finish','partner_chat_reply','partner_stickers','partner_sleep'].includes(name))return false
   return name==='partner_qq'?input?.action==='call':true
  }catch{return false}
 })
}
export function postReplyAllowed(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  if (!companion.idleContact?.enabled || route.companionId !== companion.id || (!allowSleeping && isSleeping(companion, now)) || !idleContactRouteAllowed(state, companion, route.id)) return false
  const channel = state.channels.find(c => c.id === route.channelId && c.companionId === companion.id)
  return (route.kind === 'local' || !!channel) && affectionAudienceAllowed({route, ...(channel ? {channel} : {})})
}
export function postReplyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  const pending = route.postReplyOpportunity
  return !!pending && pending.sessionId === route.sessionId && pending.policyRevision === companion.updatedAt
    && postReplyAllowed(state, companion, route, now, allowSleeping)
}
/** Shared by generation, delivery and tool dispatch; revocation takes effect immediately. */
export function activityPolicyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now(), allowSleeping = false): boolean {
  if (!companion.idleContact?.enabled) return false
  return route.idleContactState?.kind === 'post-reply'
    ? postReplyCurrent(state, companion, route, now, allowSleeping) && route.postReplyOpportunity?.status === 'claimed'
      && route.postReplyOpportunity.userMessageId === route.idleContactState.userMessageId
    : companion.idleContact.routeId === route.id
}
export const POST_REPLY_PROMPT = [
  '这是回复或自主活动完成后的「主动延续」机会。前一轮已经结束，不要重新回答、复述或解释刚才的答复。继续做事的机会会逐轮递减；无需自己安排下一轮。',
  '顺着真实话题和角色心情，判断现在是否自然想补一句、分享发现、发表情或语音，或做一件已授权的私有活动。可以只做自己的事，也可以不行动。好感度只影响获得这次机会的概率，不是要求你一定追加回复。',
  '先看用户是否表示告别、想安静或不想继续；遵守其意愿。没有具体新内容就用 partner_activity_finish 安静结束。不要凑第二条消息，不催回复，不为使用能力编造经历。',
].join('\n')
