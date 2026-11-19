import {inputOrigin} from './input-origin.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession } from '../domain.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from './delivery-policy.js'

/** A binding is not an origin. Unknown/browser messages always stay in DSH. */
export function questionOrigin(sessionId: string, events: readonly SessionEvent[], routes: readonly ChannelSession[]): ChannelSession | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (isRequirementDeliveryReceipt(event)) continue
    if (isInternalTaskNotice(event)) return undefined
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    return routes.find(route => route.sessionId === sessionId && route.kind === 'channel' && route.inboundMessageIds?.includes(event.data.id))
  }
  return undefined
}


/** A browser can open a partner-linked session without creating a second transcript. */
export function localConversationRoute(sessionId:string,routes:readonly ChannelSession[]):ChannelSession|undefined {
  const local=routes.find(route=>route.sessionId===sessionId&&route.kind==='local')
  if(local)return local
  return attachedWebRoute(sessionId,routes)
}

export function attachedWebRoute(sessionId:string,routes:readonly ChannelSession[]):ChannelSession|undefined {
  const linked=routes.filter(route=>route.sessionId===sessionId)
  const anchor=linked[0]
  if(!anchor||linked.some(route=>route.companionId!==anchor.companionId))return
  return {
    id:'web:'+anchor.companionId+':'+sessionId,kind:'local',channelId:'@local',userId:'owner:'+anchor.companionId,
    companionId:anchor.companionId,sessionId,lastMessageAt:anchor.lastMessageAt,...(anchor.cwd?{cwd:anchor.cwd}:{}),
  }
}

export function webMessageRoute(sessionId:string,events:readonly SessionEvent[],routes:readonly ChannelSession[],messageId:string):ChannelSession|undefined {
  const local=localConversationRoute(sessionId,routes)
  if(!local||routes.some(route=>route.sessionId===sessionId&&route.kind==='channel'&&route.inboundMessageIds?.includes(messageId)))return
  const origin=inputOrigin(events,messageId)
  if(origin)return origin.routeId===local.id&&origin.channelId===local.channelId&&origin.userId===local.userId?local:undefined
  if(routes.includes(local))return local
}
