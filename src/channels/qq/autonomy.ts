import {renderGroupConversationGuidance} from './conversation-guidance.js'
import { isSleeping } from '../../character/sleep.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Companion } from '../../domain.js'
import type { DirectMessage } from '../direct/transport.js'
import type { QqSettings } from './settings.js'
import { qqIdentityRelation } from './identity-binding.js'
import { affectionEnabled, affectionProgress } from '../../character/affection.js'
import { activeConversation, conversationEnded, routeGroupReply, scoreGroupReply, type ReplyScoreContext, GROUP_CONVERSATION_WINDOW_MS } from './reply-rules.js'
import { localAttentionClassifier, type AttentionClassifier } from './attention-classifier.js'

type Observation={id:string;sender:string;qqId:string;text:string;redirect:boolean;at:number}
type Conversation={at:number;text:string}
export interface GroupDecision {at:number;groupId:string;reason:string;messageId?:string;method?:'local';score?:number;probability?:number;reasons?:string[];route?:string;decisionMs?:number;contextSize?:number;semantic?:{label:string;confidence:number;margin:number;contextSimilarity?:number}}
const CONTEXT_TTL_MS=10*60_000
export const SPONTANEOUS_INTERVAL_MS=5000
/** Per-speaker threads plus optional local semantic routing. No remote LLM gate or tools. */
export class QqGroupAutonomy {
 private readonly decisions=new Map<string,GroupDecision>()
 private readonly decisionHistory=new Map<string,GroupDecision[]>()
 private readonly groups=new Map<string,{messages:Observation[];replies:Map<string,Conversation>;lastSpontaneousAt?:number}>()
 constructor(_ctx:Context,private readonly now=()=>Date.now(),private readonly classify:AttentionClassifier=localAttentionClassifier()){}
 status(channelId:string){return this.decisions.get(channelId)}
 history(channelId:string){return structuredClone(this.decisionHistory.get(channelId)??[])}
 record(channelId:string,event:DirectMessage,reason:string):false {
  if(this.decisions.size>=100&&!this.decisions.has(channelId)){const key=this.decisions.keys().next().value!;this.decisions.delete(key);this.decisionHistory.delete(key)}
  const decision:GroupDecision={at:this.now(),groupId:event.qqGroup?.groupId??'',messageId:event.id,reason}
  this.decisions.set(channelId,decision)
  const history=this.decisionHistory.get(channelId)??[];history.push(decision);if(history.length>40)history.shift();this.decisionHistory.set(channelId,history)
  return false
 }
 observe(channelId:string,event:DirectMessage):void {
  if(!event.qqGroup)return
  const key=channelId+':'+event.qqGroup.groupId
  let group=this.groups.get(key)
  if(!group){group={messages:[],replies:new Map()};this.groups.set(key,group)}
  const redirect=(!event.qqGroup.mentioned&&event.qqGroup.replyTo!=='self'&&(event.qqGroup.otherMention===true||event.qqGroup.replyTo==='other'))||conversationEnded(event.text)
  if(redirect)group.replies.delete(event.qqGroup.userId)
  const now=this.now(),sourceAt=event.timestamp??event.receivedAt
  const at=typeof sourceAt==='number'&&Number.isFinite(sourceAt)&&sourceAt>0&&sourceAt<=now?sourceAt:now
  group.messages=group.messages.filter(m=>m.id!==event.id&&now-m.at<=CONTEXT_TTL_MS)
  group.messages.push({id:event.id,qqId:event.qqGroup.userId,sender:event.qqGroup.senderName||event.qqGroup.userId,text:(event.text||'（附件消息）').slice(0,1200),redirect,at})
  group.messages=group.messages.slice(-32)
  if(this.groups.size>100)this.groups.delete(this.groups.keys().next().value!)
 }
 /** Delivery, not admission or silence, starts/extends the conversation. */
 replied(channelId:string,event:DirectMessage,text=''):void {
  if(!event.qqGroup||conversationEnded(event.text))return
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  if(!group)return
  const latest=group.messages.filter(m=>m.qqId===event.qqGroup!.userId).at(-1)
  if(latest?.redirect)return
  group.replies.delete(event.qqGroup.userId)
  group.replies.set(event.qqGroup.userId,{at:this.now(),text:text.slice(0,1200)})
  if(group.replies.size>64)group.replies.delete(group.replies.keys().next().value!)
 }
 context(channelId:string,event:DirectMessage):string {
  if(!event.qqGroup?.autonomous)return ''
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId),messages=group?.messages??[]
  const index=messages.findIndex(m=>m.id===event.id)
  const now=this.now(),at=index<0?now:messages[index]!.at
  const rows=messages.slice(0,index<0?messages.length:index).filter(m=>now-m.at<=CONTEXT_TTL_MS).slice(-16).map(({qqId,sender,text,at})=>({qqId,sender,text,at,kind:'member'}))
  for(const [qqId,reply] of group?.replies??[])if(reply.at<=at&&now-reply.at<=CONTEXT_TTL_MS)rows.push({qqId,sender:'伙伴（已确认送达）',text:reply.text||'（已发送回复，正文未记录）',at:reply.at,kind:'partner'})
  return JSON.stringify(rows.sort((a,b)=>a.at-b.at).slice(-16).map(row=>({...row,at:new Date(row.at).toISOString(),ageSeconds:Math.max(0,Math.floor((now-row.at)/1000))})))
 }
 /** Bound short-lived relevance evidence; intent still comes from the current message alone. */
 attentionContext(channelId:string,event:DirectMessage):string[] {
  const rows=JSON.parse(this.context(channelId,event)||'[]') as {text:string;kind:string;ageSeconds:number}[]
  const fresh=rows.filter(r=>r.ageSeconds<=90&&r.text.trim()&&!r.text.startsWith('（已发送回复'))
  const partner=[...fresh].reverse().find(r=>r.kind==='partner')
  return [...fresh.filter(r=>r.kind==='member').slice(partner?-3:-4).map(r=>r.text.slice(0,48)),...(partner?[partner.text.slice(0,48)]:[])]
 }
 /** Only confirmed delivery establishes a shared conversation, never admission or silence. */
 private groupRecent(channelId:string,event:DirectMessage):Conversation|undefined {
  if(!event.qqGroup)return
  const now=this.now(),inputAt=event.receivedAt??event.timestamp??now
  return [...(this.groups.get(channelId+':'+event.qqGroup.groupId)?.replies.values()??[])]
   .filter(r=>r.at<=inputAt&&now-r.at>=0&&now-r.at<GROUP_CONVERSATION_WINDOW_MS).sort((a,b)=>b.at-a.at)[0]
 }
 guidance(channelId:string,event:DirectMessage):string {
  const recent=this.groupRecent(channelId,event)
  return renderGroupConversationGuidance(recent?Math.floor((this.now()-recent.at)/1000):undefined)
 }
 async shouldReply(channelId:string,event:DirectMessage,companion:Companion,signal:AbortSignal,settings?:Partial<QqSettings>):Promise<boolean> {
  signal.throwIfAborted()
  if(event.qqGroup && isSleeping(companion,this.now()) && !event.qqGroup.mentioned && event.qqGroup.replyTo!=='self')return this.record(channelId,event,'伙伴正在睡眠，暂停群聊自主接话')
  if(!event.qqGroup?.autonomous)return true
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  const owner=qqIdentityRelation(settings,event.sender)?.matched===true
  const recent=group?.replies.get(event.qqGroup.userId),groupRecent=this.groupRecent(channelId,event)
  const relationship=companion.relationshipText??''
  const addresses=['弟弟','哥哥','姐姐','妹妹','伙伴','小家伙','小朋友','宝贝','老师','搭档'].filter(name=>relationship.includes(name))
  const context:ReplyScoreContext={name:companion.name??'',owner,addresses,affection:owner&&affectionEnabled(companion)?affectionProgress(companion.affection).score:0,now:this.now(),seed:channelId+':'+event.id,...(recent?{recent}:{}),...(groupRecent?{groupRecent}:{})}
  const index=group?.messages.findIndex(m=>m.id===event.id)??-1
  const before=(group?.messages??[]).slice(0,index<0?undefined:index)
  const other=before.filter(m=>m.qqId!==event.qqGroup!.userId).at(-1)
  const lastReply=group?Math.max(0,...[...group.replies.values()].map(r=>r.at)):0
  context.quickContinuation=!!recent&&context.now-recent.at>=0&&context.now-recent.at<=30_000&&(!other||other.at<recent.at)
  context.otherConversation=!!other&&context.now-other.at>=0&&context.now-other.at<=30_000&&!activeConversation(context)&&(!lastReply||context.now-lastReply>60_000)
  const started=performance.now()
  let result=routeGroupReply(event,context)
  let semantic
  const attentionContext=result?[]:this.attentionContext(channelId,event)
  if(!result){
   try{semantic=await this.classify(event.text,signal,attentionContext)}catch{signal.throwIfAborted()}
   signal.throwIfAborted()
   result=scoreGroupReply(event,{...context,...(semantic?{semantic}:{})})
  }
  // Bound unsolicited admissions per room, including while an earlier reply is still queued.
  // Explicit addressing and an established speaker thread are not subject to this interval.
  if(result.reply&&!activeConversation(context)&&(result.route==='opportunity'||result.route==='semantic'&&semantic?.label==='engage')&&group){
   if(group.lastSpontaneousAt!==undefined&&this.now()-group.lastSpontaneousAt<SPONTANEOUS_INTERVAL_MS)result={...result,reply:false,probability:0,reasons:['刚选择过一次群内主动接话，本条先旁听，避免连续插话']}
   else group.lastSpontaneousAt=this.now()
  }
  this.record(channelId,event,`${result.reply?'进入回复流程':'决定旁听'} · ${result.reasons.join('；')}`)
  Object.assign(this.decisions.get(channelId)!,{method:'local',score:result.score,probability:result.probability,reasons:result.reasons,route:result.route,decisionMs:Math.round(performance.now()-started),contextSize:attentionContext.length,...(semantic?{semantic}:{})})
  return result.reply
 }
}
