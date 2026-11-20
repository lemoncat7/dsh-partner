import {qqIdentityRelation} from './identity-binding.js'
import {relationshipTextForIdentity} from '../../character/relationship-adapter.js'
import {renderGroupConversationGuidance} from './conversation-guidance.js'
import {qqPersonaClauses,qqRoleText} from './attention-persona.js'
import { isSleeping } from '../../character/sleep.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Companion } from '../../domain.js'
import type { DirectMessage } from '../direct/transport.js'
import type { QqSettings } from './settings.js'
import { activeConversation, attentionMessageText, mentionsOtherRecipient, conversationEnded, routeGroupReply, scoreGroupReply, topicContinues, topicSimilarity, type ReplyScoreContext, GROUP_CONVERSATION_WINDOW_MS } from './reply-rules.js'
import { isAttentionCall, recognizedLink, recognizedRecipient, type AttentionTurn, type AttentionClassifier, type AttentionDiagnostic, type AttentionFrame, type AttentionPrediction } from './attention-classifier.js'

type Observation={id:string;sender:string;qqId:string;text:string;recipient?:string;parentId?:string;redirect:boolean;at:number;sequence:number}
type Conversation={at:number;text:string;input:string;recipient:string;observedSequence:number}
type Group={messages:Observation[];replies:Map<string,Conversation>;roomReplies:Array<Conversation&{messageId:string}>;sequence:number}
export interface GroupDecision {at:number;groupId:string;reason:string;messageId?:string;method?:'local';score?:number;probability?:number;reasons?:string[];route?:string;addressed?:boolean;linkedMessageId?:string;followupRequest?:boolean;decisionMs?:number;contextSize?:number;discussionParticipants?:number;classification?:AttentionDiagnostic;semantic?:AttentionPrediction}
const CONTEXT_TTL_MS=10*60_000
export const QUIET_CONVERSATION_WINDOW_MS=2*60*60_000
/** Per-speaker threads plus optional local semantic routing. No remote LLM gate or tools. */
export class QqGroupAutonomy {
 private readonly decisions=new Map<string,GroupDecision>()
 private readonly decisionHistory=new Map<string,GroupDecision[]>()
 private readonly groups=new Map<string,Group>()
 constructor(_ctx:Context,private readonly now=()=>Date.now(),private readonly classify:AttentionClassifier=async()=>undefined){}
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
  if(!group){group={messages:[],replies:new Map(),roomReplies:[],sequence:0};this.groups.set(key,group)}
  const redirect=(!event.qqGroup.mentioned&&event.qqGroup.replyTo!=='self'&&(mentionsOtherRecipient(event)||event.qqGroup.replyTo==='other'))||conversationEnded(event.text)
  if(redirect)group.replies.delete(event.qqGroup.userId)
  const now=this.now(),sourceAt=event.timestamp??event.receivedAt
  const at=typeof sourceAt==='number'&&Number.isFinite(sourceAt)&&sourceAt>0&&sourceAt<=now?sourceAt:now
  const existing=group.messages.find(m=>m.id===event.id)
  const sequence=existing?.sequence??++group.sequence
  const quoted=event.qqGroup.replyTo==='other'&&event.qqReplyId&&event.qqQuote?.senderId
   ?group.messages.find(m=>m.sequence<sequence&&m.qqId===event.qqQuote?.senderId&&m.id.endsWith(':'+event.qqReplyId))
   :undefined
  const parentId=quoted?.id??existing?.parentId
  group.messages=group.messages.filter(m=>m.id!==event.id&&now-m.at<=CONTEXT_TTL_MS)
  const recipient=event.qqGroup.mentioned||event.qqGroup.replyTo==='self'?'partner':event.qqGroup.replyTo==='other'?event.qqQuote?.senderId:undefined
  group.messages.push({id:event.id,qqId:event.qqGroup.userId,sender:event.qqGroup.senderName||event.qqGroup.userId,text:(event.text||'（附件消息）').slice(0,1200),...(recipient?{recipient}:{}),...(parentId?{parentId}:{}),redirect,at,sequence})
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
  const reply={at:this.now(),text:text.slice(0,1200),input:event.text.slice(0,1200),recipient:event.qqGroup.userId,observedSequence:group.sequence,messageId:event.id}
  group.replies.delete(event.qqGroup.userId)
  group.replies.set(event.qqGroup.userId,reply)
  group.roomReplies=group.roomReplies.filter(item=>item.messageId!==event.id)
  group.roomReplies.push(reply)
  if(group.roomReplies.length>8)group.roomReplies.shift()
  if(group.replies.size>64)group.replies.delete(group.replies.keys().next().value!)
 }
 context(channelId:string,event:DirectMessage):string {
  if(!event.qqGroup?.autonomous)return ''
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId),messages=group?.messages??[]
  const index=messages.findIndex(m=>m.id===event.id)
  const now=this.now(),at=index<0?now:messages[index]!.at
  const rows=messages.slice(0,index<0?messages.length:index).filter(m=>now-m.at<=CONTEXT_TTL_MS).slice(-16).map(({qqId,sender,text,at})=>({qqId,sender,text,at,kind:'member'}))
  for(const [qqId,reply] of group?.replies??[])if(reply.at<=at&&now-reply.at<=CONTEXT_TTL_MS)rows.push({qqId,sender:'伙伴（已确认送达）',text:reply.text||'（已发送回复，正文未记录）',at:reply.at,kind:'partner'})
  const quiet=this.quietRecent(channelId,event)
  if(quiet&&!rows.some(r=>r.kind==='partner'&&r.at===quiet.at))rows.push({qqId:'',sender:'伙伴（已确认送达）',text:quiet.text,at:quiet.at,kind:'partner'})
  return JSON.stringify(rows.sort((a,b)=>a.at-b.at).slice(-16).map(row=>({...row,at:new Date(row.at).toISOString(),ageSeconds:Math.max(0,Math.floor((now-row.at)/1000))})))
 }
 /** Bound short-lived group snippets; the scene policy also receives confirmed delivery evidence. */
 attentionContext(channelId:string,event:DirectMessage):string[] {
  const rows=JSON.parse(this.context(channelId,event)||'[]') as {text:string;kind:string;ageSeconds:number}[]
  const fresh=rows.filter(r=>r.ageSeconds<=90&&r.text.trim()&&!r.text.startsWith('（已发送回复'))
  const partner=[...fresh].reverse().find(r=>r.kind==='partner')
  const quiet=this.quietRecent(channelId,event)
  const speech=partner?.text??quiet?.text
  const snippets=speech?[speech.slice(0,48),...(speech.length>48?[speech.slice(-48)]:[])]:[]
  return [...fresh.filter(r=>r.kind==='member').slice(-(4-snippets.length)).map(r=>r.text.slice(0,48)),...snippets]

 }
 /** A quiet gap may preserve the last shared topic, but intervening traffic retires it.
  * Sequence evidence survives the ten-minute observation TTL and rejects queued old inputs. */
 private quietRecent(channelId:string,event:DirectMessage):Conversation|undefined {
  if(!event.qqGroup)return
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId),input=group?.messages.find(m=>m.id===event.id)
  if(!group||!input)return
  const now=this.now(),inputAt=event.receivedAt??event.timestamp??now
  const reply=[...group.replies.values()].sort((a,b)=>b.at-a.at)[0]
  if(reply&&reply.at<=inputAt&&now>=reply.at&&now-reply.at<QUIET_CONVERSATION_WINDOW_MS&&input.sequence===reply.observedSequence+1)return reply
 }
 /** Only confirmed delivery establishes a shared conversation, never admission or silence. */
 private groupRecent(channelId:string,event:DirectMessage):Conversation|undefined {
  if(!event.qqGroup)return
  const now=this.now(),inputAt=event.receivedAt??event.timestamp??now
  const replies=this.groups.get(channelId+':'+event.qqGroup.groupId)?.roomReplies??[]
  for(let index=replies.length-1;index>=0;index--){
   const reply=replies[index]!
   if(reply.at<=inputAt&&now-reply.at>=0&&now-reply.at<GROUP_CONVERSATION_WINDOW_MS)return reply
  }
 }
 /** Pass role and order without exposing QQ identifiers to the classifier. */
 private attentionDialogue(group:Group|undefined,event:DirectMessage,prior:readonly Observation[],current:Observation|undefined,quiet:Conversation|undefined):{ids:string[];turns:AttentionTurn[]} {
  if(!group||!current||!event.qqGroup)return {ids:[],turns:[]}
  const inputAt=event.receivedAt??event.timestamp??this.now(),now=this.now()
  const rows=prior.filter(turn=>turn.sequence<current.sequence&&now-turn.at<=CONTEXT_TTL_MS).map(turn=>({...turn,speaker:turn.qqId}))
  const replies=group.roomReplies.filter(reply=>reply.observedSequence<current.sequence&&reply.at<=inputAt&&(now-reply.at<=CONTEXT_TTL_MS||reply===quiet))
  const history=[...rows,...replies.map(reply=>({...reply,id:'reply:'+reply.messageId,parentId:reply.messageId,speaker:'partner',sequence:reply.observedSequence+.5}))]
   .filter(turn=>turn.text.trim()).sort((a,b)=>a.sequence-b.sequence||a.at-b.at).slice(-6)
  const ids=history.map(turn=>turn.id)
  const speakers=new Map([['partner',0],[event.qqGroup.userId,1]])
  const actor=(id:string)=>{const number=speakers.get(id)??speakers.size;speakers.set(id,number);return number}
  const turns=history.map((turn,index)=>{
   const previous=turn.parentId?ids.indexOf(turn.parentId):-1
   return {speaker:actor(turn.speaker),text:turn.text.slice(0,160),...(turn.recipient?{recipient:actor(turn.recipient)}:{}),...(previous>=0&&previous<index?{replyTo:previous}:{})}
  })
  return {ids,turns}
 }
 guidance(channelId:string,event:DirectMessage,settings?:Partial<QqSettings>):string {
  const quiet=this.quietRecent(channelId,event),recent=this.groupRecent(channelId,event)??quiet
  const decision=this.decisions.get(channelId)
  const current=decision?.messageId===event.id?decision:undefined
  const matched=!!event.qqGroup&&qqIdentityRelation(settings,event.qqGroup.userId)?.matched===true
  const guidance=renderGroupConversationGuidance(recent?Math.floor((this.now()-recent.at)/1000):undefined,current?.semantic?.scene,current?.followupRequest,current?.discussionParticipants,matched,(current?.semantic?.profileSimilarity??0)>=.45)
  if(!current?.linkedMessageId||!event.qqGroup)return guidance
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  const index=group?.messages.findIndex(m=>m.id===event.id)??-1
  const {ids,turns}=this.attentionDialogue(group,event,group?.messages.slice(0,index)??[],group?.messages[index],quiet)
  const lineage=[]
  for(let i=ids.indexOf(current.linkedMessageId);i>=0&&lineage.length<3;){
   const turn=turns[i]!
   lineage.unshift({speaker:turn.speaker===0?'伙伴':turn.speaker===1?'当前发言人':'其他群友',text:turn.text})
   i=turn.replyTo??-1
  }
  return lineage.length?guidance+'\n当前发言关联的前文（按时间排列，仅供理解）：'+JSON.stringify(lineage):guidance
 }
 async shouldReply(channelId:string,event:DirectMessage,companion:Companion,signal:AbortSignal,settings?:Partial<QqSettings>,addressOnly=false,accountId=''):Promise<boolean> {
  signal.throwIfAborted()
  if(event.qqGroup && isSleeping(companion,this.now()) && !event.qqGroup.mentioned && event.qqGroup.replyTo!=='self')return this.record(channelId,event,'伙伴正在睡眠，暂停群聊自主接话')
  if(!event.qqGroup?.autonomous)return true
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  const now=this.now(),inputAt=event.receivedAt??event.timestamp??now
  const lastSpeakerReply=group?.replies.get(event.qqGroup.userId)
  const recent=lastSpeakerReply&&lastSpeakerReply.at<=inputAt?lastSpeakerReply:undefined
  const groupRecent=this.groupRecent(channelId,event)
  const quietRecent=this.quietRecent(channelId,event)
  const context:ReplyScoreContext={name:companion.name??'',now,seed:channelId+':'+event.id,...(recent?{recent}:{}),...(groupRecent?{groupRecent}:{}),...(quietRecent?{quietRecent}:{})}

  const index=group?.messages.findIndex(m=>m.id===event.id)??-1
  const before=(group?.messages??[]).slice(0,index<0?undefined:index)
  const current=group?.messages[index]
  const latestRoomReply=groupRecent&&groupRecent.text.trim()&&current&&current.sequence>groupRecent.observedSequence
   &&!before.some(m=>m.sequence>groupRecent.observedSequence)?groupRecent:undefined
  context.latestReplyInRoom=!!latestRoomReply
  const other=before.filter(m=>m.qqId!==event.qqGroup!.userId).at(-1)
  const roomTrafficAfterReply=!!other&&(!recent||other.at>=recent.at&&other.sequence>recent.observedSequence)
  context.latestReplyToSpeaker=!!recent?.text.trim()&&(recent===groupRecent||recent===quietRecent)&&!roomTrafficAfterReply
  context.quickContinuation=!!recent&&now-recent.at>=0&&now-recent.at<=30_000&&!roomTrafficAfterReply
  context.otherConversation=!!other&&context.now-other.at>=0&&context.now-other.at<=30_000
   &&roomTrafficAfterReply&&!latestRoomReply
  let participants:number|undefined
  if(groupRecent&&current){
   const anchors=[groupRecent.input,groupRecent.text,event.text]
   const speakers=new Set([event.qqGroup.userId,groupRecent.recipient])
   for(const item of before){
    if(speakers.has(item.qqId)||item.at>inputAt||inputAt-item.at>GROUP_CONVERSATION_WINDOW_MS)continue
    if(current.parentId===item.id||item.parentId===current.id||anchors.some(anchor=>topicSimilarity(item.text,anchor)>=.24))
     speakers.add(item.qqId)
   }
   participants=speakers.size
   context.singleParticipant=participants===1&&recent===groupRecent
  }
  const started=performance.now()
  let result=routeGroupReply(event,context)
  let semantic:AttentionPrediction|undefined
  let classification:AttentionDiagnostic|undefined,linkedMessageId:string|undefined
  const attentionContext=result?[]:this.attentionContext(channelId,event)
  if(!result){
   // Persona is topical relevance, never proof of identity or authority. Relationship
   // text belongs only to the transport-verified bound speaker, not the whole room.
   const boundRelationship=qqIdentityRelation(settings,event.qqGroup.userId)?.matched===true
   const relationship=boundRelationship?relationshipTextForIdentity(companion):''
   const profile=[companion.name?.slice(0,160),...qqPersonaClauses(qqRoleText(companion),7),...qqPersonaClauses(relationship,3)]
    .filter((v):v is string=>!!v?.trim())
   const speakerText=activeConversation(context)?recent?.text:undefined
   const dialogue=this.attentionDialogue(group,event,before,current,quietRecent)
   const frame:AttentionFrame={groupScope:JSON.stringify([channelId,accountId,event.qqGroup.groupId]),...(relationship?{boundRelationship:relationship.slice(0,4096)}:{}),profile,partnerText:(latestRoomReply?.text||speakerText||groupRecent?.text||quietRecent?.text||'').slice(0,160),dialogue:dialogue.turns}
   try{semantic=await this.classify(attentionMessageText(event),signal,attentionContext,value=>{classification=value},frame)}catch{signal.throwIfAborted()}
   signal.throwIfAborted()
   const link=semantic?.link,index=link?.index
   if(semantic&&link&&typeof index==='number'&&recognizedLink(link)){
    const turn=dialogue.turns[index]
    if(turn&&turn.speaker!==1){
     linkedMessageId=dialogue.ids[index]
     if(current&&linkedMessageId&&!current.parentId)current.parentId=linkedMessageId
     semantic={...semantic,recipient:{label:turn.speaker===0?'partner':'member',confidence:link.confidence,margin:link.margin}}
    }
   }
   result=scoreGroupReply(event,{...context,...(semantic?{semantic}:{})})
  }
  // Resolve ambiguous embedded mentions after semantics; confirmed redirects retire the
  // speaker thread, while references to somebody else preserve delivered continuity.
  if(result.route==='other'&&event.qqGroup.otherMention&&!event.qqGroup.mentioned&&event.qqGroup.replyTo!=='self'&&group){
   const observation=group.messages.find(m=>m.id===event.id)
   if(observation)observation.redirect=true
   group.replies.delete(event.qqGroup.userId)
  }
  // Busy work still lets the local model recognize a call; only calls queue.
  const recipient=recognizedRecipient(semantic?.recipient)
  const recognizedCall=recipient==='partner'||(recipient!=='member'&&isAttentionCall(semantic))
  if(addressOnly&&result.route!=='direct'&&!(result.reply&&recognizedCall))result={...result,reply:false,probability:0,reasons:[...result.reasons,'任务执行期间普通群聊仅旁听，不插入或排队补答']}
  if(!semantic&&classification){
   const statusText={empty:'当前只有附件，没有文字可供本地语义识别',busy:'本地识别并发已满',backoff:'本地识别短暂退避',timeout:'本地识别请求超时',transport:'本地识别连接异常',http:'本地识别服务返回错误',invalid:'本地识别返回无效结果',unconfigured:'未配置本地识别服务',ok:''}[classification.status]
   if(statusText)result={...result,reasons:[...result.reasons,statusText]}
  }
  this.record(channelId,event,`${result.reply?'进入回复流程':'决定旁听'} · ${result.reasons.join('；')}`)
  Object.assign(this.decisions.get(channelId)!,{method:'local',score:result.score,probability:result.probability,reasons:result.reasons,route:result.route,addressed:result.reply&&(result.route==='direct'||recognizedCall),...(result.reply&&result.followupRequest?{followupRequest:true}:{}),...(linkedMessageId?{linkedMessageId}:{}),decisionMs:Math.round(performance.now()-started),contextSize:attentionContext.length,...(participants!==undefined&&(result.route==='continuation'||topicContinues(event.text,{...context,...(semantic?{semantic}:{})}))?{discussionParticipants:participants}:{}),...(classification?{classification}:{}),...(semantic?{semantic}:{})})
  return result.reply
 }
}
