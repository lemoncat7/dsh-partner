import type { PartnerState } from '../domain.js'

/** The companion has one shared conversation. Explicit delivery targets win;
 * otherwise use the latest inbound channel, never background session activity. */
export function notificationRoute(state: PartnerState, channelId: string, userId: string): {channelId: string; userId: string} {
  const source=state.channels.find(c=>c.id===channelId)
  const pairing=state.pairings.find(p=>p.channelId===channelId&&p.userId===userId)
  if(!source?.enabled || pairing?.status!=='approved')throw new Error('通知来源渠道停用或联系人尚未授权')
  const target=pairing.deliveryTarget ?? state.pairings.filter(p=>p.lastInboundAt!==undefined&&state.channels.some(c=>c.id===p.channelId&&c.companionId===source.companionId)).sort((a,b)=>(b.lastInboundAt??0)-(a.lastInboundAt??0))[0] ?? {channelId,userId}
  // Deliberately do not pick an older enabled channel when the latest is stopped.
  if(!state.channels.some(c=>c.id===target.channelId&&c.companionId===source.companionId&&c.enabled)||!state.pairings.some(p=>p.channelId===target.channelId&&p.userId===target.userId&&p.status==='approved'))throw new Error('指定或最近通知渠道不可用，保留待投递，不自动切换渠道')
  return {channelId:target.channelId,userId:target.userId}
}
