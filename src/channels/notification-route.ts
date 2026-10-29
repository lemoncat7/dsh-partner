import {channelReplyAllowed} from './reply-access.js'
import { qqGroupRoute } from './qq/settings.js'
import type { PartnerState } from '../domain.js'

export function notificationRoutes(state: PartnerState, channelId: string, userId: string, companionId?:string): {channelId:string;userId:string}[] {
  if(qqGroupRoute({channelId,userId},state.channels))return [notificationRoute(state,channelId,userId)]
  const source = state.channels.find(c => c.id === channelId)
  const owner = source?.companionId ?? companionId
  const config = state.companions?.find(c => c.id === owner)?.notificationDelivery
  if (config?.mode === 'selected') {
    if (!config.targets.length) throw new Error('通知未配置接收人')
    return config.targets.map(target => ({...target}))
  }
  if (config?.mode === 'recent') {
    const clean = {...state, pairings: state.pairings.map(({deliveryTarget: _legacy, ...p}) => p)}
    if (!source) {
      const latest = clean.pairings.filter(p=>!qqGroupRoute(p,state.channels)&&p.lastInboundAt!==undefined&&clean.channels.some(c=>c.id===p.channelId&&c.companionId===owner)).sort((a,b)=>(b.lastInboundAt??0)-(a.lastInboundAt??0))[0]
      if (!latest) throw new Error('暂无最近联系的渠道与用户')
      return [notificationRoute(clean,latest.channelId,latest.userId)]
    }
    return [notificationRoute(clean, channelId, userId)]
  }
  return [notificationRoute(state, channelId, userId)]
}

/** The companion has one shared conversation. Explicit delivery targets win;
 * otherwise use the latest inbound channel, never background session activity. */
export function notificationRoute(state: PartnerState, channelId: string, userId: string): {channelId: string; userId: string} {
  const source=state.channels.find(c=>c.id===channelId)
  const pairing=state.pairings.find(p=>p.channelId===channelId&&p.userId===userId)
  if(!source?.enabled || !channelReplyAllowed(state,channelId,userId))throw new Error('通知来源渠道停用或联系人尚未授权')
  if(qqGroupRoute({channelId,userId},state.channels))return {channelId,userId}
  const target=pairing?.deliveryTarget ?? state.pairings.filter(p=>!qqGroupRoute(p,state.channels)&&p.lastInboundAt!==undefined&&state.channels.some(c=>c.id===p.channelId&&c.companionId===source.companionId)).sort((a,b)=>(b.lastInboundAt??0)-(a.lastInboundAt??0))[0] ?? {channelId,userId}
  // Deliberately do not pick an older enabled channel when the latest is stopped.
  if(!state.channels.some(c=>c.id===target.channelId&&c.companionId===source.companionId&&c.enabled)||!channelReplyAllowed(state,target.channelId,target.userId))throw new Error('指定或最近通知渠道不可用，保留待投递，不自动切换渠道')
  return {channelId:target.channelId,userId:target.userId}
}
