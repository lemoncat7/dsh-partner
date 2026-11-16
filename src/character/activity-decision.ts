import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {Companion,PartnerState} from '../domain.js'
import type {PartnerStore} from '../store.js'
import type {ChannelActivitySummary} from '../channels/activity-registry.js'
import {currentAffectionAudience} from './affection-context.js'
import {canFinishIdleActivity} from './activity-tool.js'
import {isIdleContactNotice} from './idle-contact.js'
import {planActivity} from './activity-plan.js'

export const ACTIVITY_KINDS=['continue','topic','task','explore','social'] as const
export type ActivityKind=typeof ACTIVITY_KINDS[number]
export interface ActivityDecision {at:number;routeId:string;kind:ActivityKind|'none';reason:string;outcome:'scheduled'|'declined'|'none';detail:string;planId?:string}
export const NEXT_ACTIVITY_SCHEMA={type:'object',additionalProperties:false,required:['kind'],properties:{
 kind:{type:'string',enum:[...ACTIVITY_KINDS,'none'],description:'continue 接着聊；topic 有缘由的新话题；task 自己想推进的事；explore 浏览探索；social 空间/B站等互动；none 不新增后续意图。'},
 cancelPending:{type:'boolean',description:'仅 kind=none 时可用；true 撤回本轮此前的计划，省略则保留已经安排的意图。'},
 reason:{type:'string',minLength:1,maxLength:300,description:'kind 非 none 时必填。基于当前交流、真实发现或已知事项，具体想继续做什么及缘由；这是自己的意图，不是完成结果，不是发送给用户的话。'},
 delayMinutes:{type:'number',minimum:0,maximum:1440,description:'确有等待理由才填；省略或 0 表示本轮确认结束后下次检查，不等闲时频率。'}
}}
export interface ActivityInterest {state:'engaged'|'settled'|'quiet';focus:string;kind:ActivityKind;at:number;expiresAt:number;routeId:string;sessionId:string;sourceInputId:string;userMessageId:string;policyRevision:number;detail:string}
export const INTEREST_LIMIT=2
export const INTEREST_SCHEMA={type:'object',additionalProperties:false,required:['state','focus','kind'],properties:{
 state:{type:'string',enum:['engaged','settled','quiet'],description:'engaged 仍在兴头上或想继续陪伴，即使尚未想好具体下一步；settled 此刻满足了或自己想休息；quiet 对方明确要求结束或不再打扰。不是当前回答是否完成。'},
 focus:{type:'string',minLength:1,maxLength:200,description:'仍在意的具体话题、兴趣，或此刻想停的依据；不是发给用户的话，不编造任务。'},
 kind:{type:'string',enum:[...ACTIVITY_KINDS],description:'兴趣方向：接话、新话题、推进事情、浏览探索、平台互动。'}
}}
export function interestWakes(c:Companion,now=Date.now()):number[]{return (c.interestWakeHistory??[]).filter(at=>at<=now&&now-at<3600000)}
export function quietInterest(c:Companion,routeId:string,userMessageId:string,now=Date.now()):boolean{
 const i=c.activityInterest
 return !!i&&i.state==='quiet'&&i.routeId===routeId&&i.userMessageId===userMessageId&&i.expiresAt>now&&i.policyRevision===c.updatedAt
}
function origin(state:PartnerState,owner:string,sessionId:string,events:readonly SessionEvent[]){
 const event=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
 const automatic=!!event&&isIdleContactNotice(event)
 const routes=state.sessions.filter(r=>r.companionId===owner&&r.sessionId===sessionId)
 const route=automatic?routes.find(r=>event?.type==='user/message'&&r.idleContactState?.messageId===event.data.id):routes.find(r=>r.kind==='channel'&&event?.type==='user/message'&&r.inboundMessageIds?.includes(event.data.id))??routes.find(r=>r.kind==='local')
 return {event,automatic,route}
}
export function activityDecisionAvailable(state:PartnerState,c:Companion,sessionId:string,events:readonly SessionEvent[]):boolean {
 const {event,automatic,route}=origin(state,c.id,sessionId,events)
 return !!c.idleContact?.enabled&&!!event&&!!route&&(automatic?route.idleContactState?.kind!=='continuous'&&canFinishIdleActivity(c.id,state,sessionId,events):currentAffectionAudience(state,c.id,sessionId,events))
}
/** Presentation only; registration and public/guest execution permissions stay intact. */
export function withActivityChoiceSchema<T extends {name:string;parameters:unknown}>(tool:T,required:boolean):T {
 if(!required||!['partner_chat_reply','partner_activity_finish'].includes(tool.name))return tool
 const schema=tool.parameters as Record<string,unknown>,properties=schema?.properties as Record<string,unknown>|undefined
 if(!properties?.interest)return tool
 return {...tool,parameters:{...schema,required:[...new Set([...(Array.isArray(schema.required)?schema.required:[]).filter(k=>k!=='nextActivity'),'interest'])]}}
}
export function renderActivityDecisionContext(state:PartnerState,c:Companion,sessionId:string,events:readonly SessionEvent[],catalog:ChannelActivitySummary[]):string{
 if(!activityDecisionAvailable(state,c,sessionId,events))return ''
 const {automatic,route}=origin(state,c.id,sessionId,events)
 if(!route)return ''
 const groups=new Map<string,Array<{title:string;discover:boolean}>>()
 for(const group of catalog){const rows=groups.get(group.platform)??[];for(const a of group.activities)if(!rows.some(r=>r.title===a.title))rows.push({title:a.title,discover:!!a.discoveryOperations?.length});groups.set(group.platform,rows)}
 for(const rows of groups.values())rows.sort((a,b)=>Number(b.discover)-Number(a.discover))
 const options:string[]=[]
 for(let index=0;options.length<12;index++){let found=false;for(const [platform,rows] of groups){const row=rows[index];if(!row)continue;found=true;options.push(platform+' · '+row.title);if(options.length===12)break}if(!found)break}
 const ownPlan=c.activityPlan?.sourceRouteId===route.id&&['waiting','pending'].includes(c.activityPlan.status)?{intention:c.activityPlan.intention,dueAt:c.activityPlan.dueAt}:undefined
 const depth=automatic?route.idleContactState?.depth??0:0
 return "【本轮说完之后的交流状态 · 不对外播报】interest 记录此刻的兴趣，不是下一步任务，也不是当前回答是否完成。state=engaged 表示还在兴头上、想继续陪伴或对刚聊到的东西仍有好奇，即使暂时没想好下一句/具体行动也可以；focus 简短写自己仍在意的具体话题或想做的事，kind 区分 continue/topic/task/explore/social。state=settled 表示这会儿满足了、不想再接或自己想休息；state=quiet 仅用于对方明确要求结束或不再打扰，将暂停该会话的自主唤起，直到对方再次发言或一天后重新判断。按当前人物、关系、时间和实际交流判断，不机械每轮 engaged，也不因发完一句话默认 settled。\n用户仍在接话、分享高兴或希望你陪着聊时，可以保持 engaged；自己整理完无新感受可以 settled。现在想说的话放在本轮 messages，想边说边做用 continueTurn:true；当前交办的任务现在执行，不以之后的活动代替。nextActivity 只有具体的后续安排时才填；没有具体计划可不填，interest.engaged 与 nextActivity.none 可以同时成立。明确安排的优先，none 默认保留已有安排，cancelPending:true 才撤回本轮安排。\nengaged 在本轮确认送达后留一次短暂机会，由同一会话按当时语境决定接话、做事或安静结束；不强制发送，不等于承诺已执行。新消息优先，不重复刚送达的话。兴趣机会每小时最多两次，十分钟内未执行即过期，不反复补跑；具体后续仍受连续三轮上限约束。\n浏览、互动、公开发布和向对方分享分别决定，不必每次整理后汇报；可按人物表达感受、关心、联想和真实发现，不要求先有新任务或作品，不公开私人聊天。对方没回不自动拉长间隔，也不编造对方经历。所有行为沿用当前人格与原权限。\n"+
 JSON.stringify({availableDirections:options,continuationsLeft:Math.max(0,3-depth),interestOpportunitiesLeft:Math.max(0,INTEREST_LIMIT-interestWakes(c).length),...(ownPlan?{pendingIntention:ownPlan}:{})})
}
/** Durable model-authored choice; never a random callback or a second model invocation. */
export async function saveNextActivity(owner:string,store:PartnerStore,sessionId:string,events:()=>readonly SessionEvent[],raw:unknown,signal:AbortSignal):Promise<void>{
 if(raw===undefined||raw===null)return
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('nextActivity 格式无效')
 const input=raw as Record<string,unknown>,v:Record<string,unknown>={...input,reason:input.reason??(input.kind==='none'?'本轮未选择新的后续意图':undefined)}
 if(![...ACTIVITY_KINDS,'none'].includes(v.kind as ActivityKind)||typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>300||v.delayMinutes!==undefined&&(typeof v.delayMinutes!=='number'||!Number.isFinite(v.delayMinutes)||v.delayMinutes<0||v.delayMinutes>1440))throw Error('请填写有效的下一步类型、具体意图和等待时间')
 await store.update(state=>{
  signal.throwIfAborted();const c=state.companions.find(c=>c.id===owner);if(!c||store.isCompanionRemoving(owner))throw Error('伙伴不可用')
  const current=events(),{event,automatic,route}=origin(state,owner,sessionId,current)
  if(!route||event?.type!=='user/message')return
  const record:ActivityDecision={at:Date.now(),routeId:route.id,kind:v.kind as ActivityKind|'none',reason:v.reason as string,outcome:'declined',detail:''}
  c.activityDecision=record
  if(!c.idleContact?.enabled||automatic&&!canFinishIdleActivity(owner,state,sessionId,current)||!automatic&&!currentAffectionAudience(state,owner,sessionId,current)){record.detail='当前来源或开关不允许后续活动，正常回复不受影响';return}
  if(automatic&&route.idleContactState?.kind==='continuous'){record.detail='持续陪伴本轮仅接话或安静结束，不另起活动绕过任务预算';return}
  if(v.kind==='none'){
   const p=c.activityPlan;if(v.cancelPending===true&&p?.sourceInputId===event.data.id&&p.sourceSessionId===sessionId&&['waiting','pending'].includes(p.status)){p.status='cancelled';p.result=v.reason as string}
   record.outcome='none';record.detail='本轮不新增后续活动';return
  }
  try{const planned=planActivity(state,c,sessionId,current,{reason:v.reason as string,delayMinutes:(v.delayMinutes as number|undefined)??0,kind:v.kind as ActivityKind});record.outcome='scheduled';record.planId=planned.id;record.detail='已记录意图，等待本轮确认结束'}catch(error){record.detail=(error instanceof Error?error.message:String(error)).slice(0,300)}
 })
}

/** Interest and an explicit task plan are independent; no new decision-model request. */
export async function saveTurnInterest(owner:string,store:PartnerStore,sessionId:string,events:()=>readonly SessionEvent[],raw:unknown,signal:AbortSignal):Promise<void>{
 if(raw===undefined)return
 const v=raw as {state:ActivityInterest['state'];focus:string;kind:ActivityKind}
 if(!v||typeof v!=='object'||!['engaged','settled','quiet'].includes(v.state)||typeof v.focus!=='string'||!v.focus.trim()||v.focus.length>200||!ACTIVITY_KINDS.includes(v.kind))throw Error('请记录有效的兴趣状态、具体依据和方向')
 await store.update(state=>{
  signal.throwIfAborted();const c=state.companions.find(c=>c.id===owner)
  if(!c||store.isCompanionRemoving(owner)||!activityDecisionAvailable(state,c,sessionId,events()))return
  const current=events(),{event,automatic,route}=origin(state,owner,sessionId,current)
  if(!route||event?.type!=='user/message')return
  const now=Date.now(),interest:ActivityInterest={state:v.state,focus:v.focus.trim(),kind:v.kind,at:now,expiresAt:now+(v.state==='quiet'?86400000:600000),routeId:route.id,sessionId,sourceInputId:event.data.id,userMessageId:automatic?route.idleContactState!.userMessageId:event.data.id,policyRevision:c.updatedAt,detail:''}
  c.activityInterest=interest
  const p=c.activityPlan
  if(v.state!=='engaged'){
   if(p?.trigger==='interest'&&p.sourceRouteId===route.id&&p.sourceInputId===event.data.id&&['waiting','pending'].includes(p.status)){p.status='cancelled';p.result='本轮不再保留续接兴趣'}
   interest.detail=v.state==='quiet'?'暂停本会话自主唤起，新消息优先；最长保留一天':'本轮先告一段落，不另起兴趣续接'
   return
  }
  if(p&&['waiting','pending'].includes(p.status)){interest.detail='已有后续安排，不另外排入兴趣机会';return}
  if(interestWakes(c,now).length>=INTEREST_LIMIT){interest.detail='本小时两次兴趣机会已用完，不额外唤起；之后仍可正常闲时活动';return}
  try{
   const plan=planActivity(state,c,sessionId,current,{reason:interest.focus,kind:interest.kind,delayMinutes:0.75})
   plan.trigger='interest';plan.expiresAt=now+600000
   interest.detail='等待本轮确认送达，再留一次兴趣续接机会'
   c.activityDecision={at:now,routeId:route.id,kind:interest.kind,reason:interest.focus,outcome:'scheduled',detail:interest.detail,planId:plan.id}
  }catch(error){interest.detail=(error instanceof Error?error.message:String(error)).slice(0,300)}
 })
}
