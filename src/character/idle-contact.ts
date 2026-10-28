import type { Companion, PartnerState } from '../domain.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface IdleContactPolicy {
  enabled: boolean
  routeId: string
  idleMinutes: number
  dailyLimit: number
  quietStartHour: number
  quietEndHour: number
}
export interface IdleContactState {
  timeZone: string
  policyRevision: number
  userMessageId: string
  messageId: string
  attemptedAt: number
  day: string
  count: number
}
export const DEFAULT_IDLE_CONTACT: IdleContactPolicy = { enabled: false, routeId: '', idleMinutes: 120, dailyLimit: 2, quietStartHour: 23, quietEndHour: 9 }
export const IDLE_CONTACT_NOTICE = '伙伴闲时主动联系'
export function normalizeIdleContact(value: unknown): IdleContactPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('闲时联系配置无效')
  const v = value as Record<string, unknown>
  if (typeof v.enabled !== 'boolean') throw new Error('请选择是否开启闲时联系')
  const result = {...DEFAULT_IDLE_CONTACT, enabled:v.enabled}
  if (typeof v.routeId !== 'string' || v.routeId.length > 200) throw new Error('请选择联系会话')
  result.routeId = v.routeId
  for (const [key,min,max] of [['idleMinutes',30,1440],['dailyLimit',1,5],['quietStartHour',0,23],['quietEndHour',0,23]] as const) {
    const number = v[key] ?? result[key]
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw new Error(`${key} 须为 ${min}–${max} 的整数`)
    result[key] = number
  }
  if (result.enabled && !result.routeId) throw new Error('请先选择联系会话')
  return result
}
export function idleContactDay(now:number,timeZone:string):string {
  return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
}
export function idleContactQuiet(policy:IdleContactPolicy,now:number,timeZone:string):boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',hourCycle:'h23'}).format(now))
  const {quietStartHour:start,quietEndHour:end}=policy
  return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end
}
export function idleContactRouteAllowed(state:PartnerState,companion:Companion,routeId:string):boolean {
  const route=state.sessions.find(r=>r.id===routeId&&r.companionId===companion.id)
  return Boolean(route && (route.kind==='local' || (state.channels.some(c=>c.id===route.channelId&&c.companionId===companion.id&&c.enabled) && state.pairings.some(p=>p.channelId===route.channelId&&p.userId===route.userId&&p.status==='approved'))))
}
export function lastIdleContactUser(events:readonly SessionEvent[]):{id:string;at:number}|undefined {
  for(let i=events.length-1;i>=0;i--) {
    const e=events[i]!
    if(e.type==='user/message'&&e.data.source.kind==='user')return {id:e.data.id,at:e.time}
  }
  return undefined
}
export function idleContactDue(state:PartnerState,companion:Companion,user:{id:string;at:number}|undefined,now:number,timeZone:string):boolean {
  const policy=companion.idleContact
  if(!policy?.enabled||!user||!idleContactRouteAllowed(state,companion,policy.routeId)||idleContactQuiet(policy,now,timeZone))return false
  const route=state.sessions.find(r=>r.id===policy.routeId)!
  const previous=route.idleContactState
  if(previous?.userMessageId===user.id)return false // Never nag again until a real new user message.
  const latestActivity=Math.max(user.at,...state.sessions.filter(r=>r.companionId===companion.id).map(r=>r.lastMessageAt),previous?.attemptedAt??0)
  if(now-latestActivity<policy.idleMinutes*60_000)return false
  const day=idleContactDay(now,timeZone)
  const attempts=state.sessions.filter(r=>r.companionId===companion.id).reduce((n,r)=>n+(r.idleContactState?.day===day?r.idleContactState.count:0),0)
  return attempts<policy.dailyLimit
}
export function isIdleContactNotice(event:SessionEvent):boolean {
  return event.type==='user/message' && event.data.source.kind==='plugin:@lemoncat7/dsh-partner' && event.data.source.form==='notice' && event.data.source.summary===IDLE_CONTACT_NOTICE
}
