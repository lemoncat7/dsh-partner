import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import { isIdleContactNotice } from './idle-contact.js'
import { affectionAudienceAllowed } from './affection-adapter.js'

/** Resolve from persisted provenance, never from names or text claiming ownership. */
export function affectionForInput(state: PartnerState, owner: string, sessionId: string, input: SessionEvent): boolean {
  if(input.type!=='user/message'||isInternalTaskNotice(input))return false
  const routes=state.sessions.filter(r=>r.companionId===owner&&r.sessionId===sessionId)
  const autonomous=isIdleContactNotice(input)
  if(!autonomous&&input.data.source.kind!=='user')return false
  const route=autonomous?routes.find(r=>r.idleContactState?.messageId===input.data.id)
    :routes.find(r=>r.kind==='channel'&&r.inboundMessageIds?.includes(input.data.id))??routes.find(r=>r.kind==='local')
  if(!route)return false
  const channel=state.channels?.find(c=>c.id===route.channelId&&c.companionId===owner)
  if(route.kind==='channel'&&!channel)return false
  return affectionAudienceAllowed({route,...(channel?{channel}:{}),autonomous})
}
export function currentAffectionAudience(state: PartnerState, owner: string, sessionId: string, events: readonly SessionEvent[]): boolean {
  for(let i=events.length-1;i>=0;i--){const e=events[i]!;if(e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)))return affectionForInput(state,owner,sessionId,e)}
  return false
}
export function affectionTurnEligible(state: PartnerState, owner: string, sessionId: string, events: readonly SessionEvent[]): boolean {
  const inputs=events.filter(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)))
  return inputs.length>0&&inputs.every(e=>e.type==='user/message'&&e.data.source.kind==='user'&&affectionForInput(state,owner,sessionId,e))
}
