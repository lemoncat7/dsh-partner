import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { questionOrigin } from '../channels/question-origin.js'
import { channelReplyAllowed } from '../channels/reply-access.js'
import { qqSettings } from '../channels/qq/settings.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { actualAction } from './action-obligation.js'

/** An input-scoped affordance, never a collection queue, automatic upload or catalogue dump. */
export function renderStickerOpportunity(state: PartnerState, owner: string, sessionId: string, events: readonly SessionEvent[]): string {
  const card=state.companions.find(c=>c.id===owner)?.characterCard
  if(!card?.enabled||!card.stickersEnabled)return ''
  const input=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e)))
  // Only a real current image input, not quoted paths, memory hits or autonomous notices.
  if(input?.type!=='user/message'||input.data.source.kind!=='user'||!input.data.content.some(b=>b.type==='image'))return ''
  const route=questionOrigin(sessionId,events,state.sessions)
  const channel=state.channels.find(c=>c.id===route?.channelId&&c.companionId===owner)
  if(!route||route.companionId!==owner||channel?.platform!=='qq'||!channelReplyAllowed(state,channel.id,route.userId))return ''
  const policy=qqSettings(channel.qq)
  if(!policy.enabledActions.includes('add_custom_face'))return ''
  for(const e of events.slice(events.indexOf(input)+1))if(e.type==='tool/call'||e.type==='tool/ptc-dispatch'){
    const c=actualAction(e.data.name,e.data.arguments)
    if(c.name==='partner_qq'&&c.args.action==='call'&&c.args.operation==='add_custom_face')return ''
  }
  return '【本轮图片的收藏入口】先看图，按当前人格决定是否想留着以后用；喜欢且适合作表情时可以当场收藏，不必等对方要求，不合适就略过。当前已开启 partner_qq 的 add_custom_face，channelId='+JSON.stringify(channel.id)+'；可直接经 partner_tools call name=partner_qq，argumentsJson 填 {action:"call",channelId,operation:"add_custom_face",params:{file:消息中已保存的原图路径}} 的 JSON。保留 GIF 原文件，工具会检查重复；没有可用原文件时不要猜路径。'+(policy.enabledActions.includes('modify_custom_face')?'成功后可用 modify_custom_face 给返回的 emoji_id 加简短标签。':'')+'是否收藏不影响正常接话，不必另外写收藏总结。'
}
