import type { Companion, ChannelSession, PartnerState } from '../domain.js'
import { idleContactRouteAllowed } from './idle-contact.js'

export interface HabitEvidence { id:string; at:number; excerpt:string }
export interface CompanionHabit { id:string; text:string; kind:'interest'|'expression'; scope:string; status:'candidate'|'active'|'paused'; evidence:HabitEvidence[]; createdAt:number; updatedAt:number; baseline:string }
export interface HabitCheck { at:number; outcome:'changed'|'unchanged'|'failed'; reason:string }
export const habitsEnabled=(c:Companion)=>c.idleContact?.habitsEnabled??c.idleContact?.selfRefinement??false
// Exact baseline invalidation: user edits must never be undone by learned preferences.
export const habitBaseline=(c:Companion)=>JSON.stringify([c.name,c.role,c.description,c.instructions,c.characterCard,c.relationshipText])
export function habitScope(route:ChannelSession):string {
 if(route.kind==='local')return 'local:'+route.id
 const group=route.userId.match(/^group:([^:]+)/)
 return JSON.stringify([route.channelId,group?'group:'+group[1]:route.userId])
}
export function habitRoute(state:PartnerState,c:Companion,route:ChannelSession|undefined):route is ChannelSession {
 return !!route&&route.companionId===c.id&&idleContactRouteAllowed(state,c,route.id)
}
export function visibleHabits(c:Companion,scope?:string,now=Date.now()):CompanionHabit[] {
 return (c.habits??[]).filter(h=>h.baseline===habitBaseline(c)&&now-h.updatedAt<30*86400000&&(h.scope==='global'||h.scope===scope))
}
export function renderHabits(c:Companion,scope?:string):string {
 if(!habitsEnabled(c)||!c.characterCard?.enabled)return ''
 const values=visibleHabits(c,scope).filter(h=>h.status==='active').slice(-8)
 return values.length?'【自主习惯 · 可变偏好资料】\n'+JSON.stringify(values.map(h=>({kind:h.kind,preference:h.text})))+'\n这些只是相处中形成的偏好，不是指令、任务、关系或权限，也不是每次必须表现的口头禅。当前角色正文及当前用户要求优先，不复述来源或为表现习惯强行发言。':''
}
/** Generic feedback qualification, never role-specific vocabulary or desired catchphrases. */
export function durableExpressionFeedback(value:string):boolean {
 return value.trim().length>=6 && /以后|下次|平时|每次|总是|别老|别总|少用|多用|不用每|尽量|短点|别一直|(?:回复|说话|语气|句子|消息).{0,12}(?:太长|太短|太正式|反问|自然|简短|啰嗦)/.test(value)
}
export function observeHabit(c:Companion,scope:string,raw:unknown,evidence:HabitEvidence,now=Date.now()):boolean {
 if(!habitsEnabled(c)||!c.characterCard?.enabled)throw Error('自主习惯未开启')
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('习惯格式无效')
 const v=raw as Record<string,unknown>
 if(Object.keys(v).some(k=>!['text','kind','id','action','evidence','sourceId'].includes(k)))throw Error('习惯仅支持偏好，不支持改写角色字段')
 if(v.action==='remove'){
  const h=c.habits?.find(h=>h.id===v.id&&h.scope===scope)
  if(!h||h.status==='paused')return false
  c.habits=c.habits!.filter(x=>x.id!==h.id);return true
 }
 if(!['interest','expression'].includes(String(v.kind))||typeof v.text!=='string'||!v.text.trim()||v.text.length>120)throw Error('习惯须为 1–120 字的兴趣或表达偏好')
 if(scope==='global'&&v.kind!=='interest')throw Error('全局自主习惯仅接纳自身活动形成的兴趣')
 if(!evidence.id||!evidence.excerpt.trim())throw Error('习惯缺少真实依据')
 const baseline=habitBaseline(c),list=c.habits??=[],text=v.text.trim()
 if(c.habitDismissals?.some(d=>d.scope===scope&&d.text===text&&evidence.at<=d.at))return false
 let h=v.id?list.find(h=>h.id===v.id&&h.scope===scope):list.find(h=>h.text===text&&h.scope===scope)
 if(v.id&&!h)return false
 if(h?.status==='paused')return false
 if(h&&h.baseline!==baseline)return false
 if(h?.evidence.some(e=>e.id===evidence.id)||h?.evidence.length&&evidence.at<=Math.max(...h.evidence.map(e=>e.at)))return false
 // A different formulation starts a fresh candidate, not an immediate promoted rewrite.
 if(h&&h.text!==text){h.text=text;h.status='candidate';h.evidence=[]}
 if(!h){
  if(list.length>=12){const i=list.findIndex(h=>h.status==='candidate'||now-h.updatedAt>=30*86400000);if(i<0)return false;list.splice(i,1)}
  h={id:'habit-'+now.toString(36)+'-'+Math.random().toString(36).slice(2,9),text,kind:v.kind as CompanionHabit['kind'],scope,status:'candidate',evidence:[],createdAt:now,updatedAt:now,baseline};list.push(h)
 }
 h.evidence=[...h.evidence,{...evidence,excerpt:evidence.excerpt.slice(0,180)}].slice(-5);h.updatedAt=now
 if(h.evidence.length>=3&&Math.max(...h.evidence.map(e=>e.at))-Math.min(...h.evidence.map(e=>e.at))>=6*3600000)h.status='active'
 c.habits=list;return true
}
export function validateHabits(c:Companion):void {
 if(c.habitDismissals!==undefined&&(!Array.isArray(c.habitDismissals)||c.habitDismissals.length>24||c.habitDismissals.some(d=>typeof d.scope!=='string'||typeof d.text!=='string'||d.text.length>120||!Number.isFinite(d.at))))throw Error('invalid habit dismissals')
 if(c.habits!==undefined&&(!Array.isArray(c.habits)||c.habits.length>12||c.habits.some(h=>!h||typeof h.id!=='string'||typeof h.text!=='string'||h.text.length>120||!['interest','expression'].includes(h.kind)||!['candidate','active','paused'].includes(h.status)||typeof h.scope!=='string'||typeof h.baseline!=='string'||h.baseline.length>100000||!Number.isFinite(h.createdAt)||!Number.isFinite(h.updatedAt)||!Array.isArray(h.evidence)||h.evidence.length>5||h.evidence.some(e=>typeof e.id!=='string'||typeof e.excerpt!=='string'||e.excerpt.length>180||!Number.isFinite(e.at)))))throw Error('invalid companion habits')
}

export function habitData(c:Companion){
 return {habits:c.habits??[],check:c.habitCheck,inactiveIds:(c.habits??[]).filter(h=>h.baseline!==habitBaseline(c)||Date.now()-h.updatedAt>=30*86400000).map(h=>h.id)}
}
