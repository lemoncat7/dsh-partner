import { isSleeping } from '../../character/sleep.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Companion } from '../../domain.js'
import type { DirectMessage } from '../direct/transport.js'
import type { QqSettings } from './settings.js'
import { qqIdentityRelation } from './identity-binding.js'
import { affectionEnabled, affectionProgress } from '../../character/affection.js'
import { conversationEnded, routeGroupReply, scoreGroupReply, type ReplyScoreContext } from './reply-rules.js'
import { localAttentionClassifier, type AttentionClassifier } from './attention-classifier.js'

type Observation={id:string;sender:string;qqId:string;text:string;redirect:boolean}
type Conversation={at:number;text:string}
/** Per-speaker threads plus optional local semantic routing. No remote LLM gate or tools. */
export class QqGroupAutonomy {
 private readonly decisions=new Map<string,{at:number;groupId:string;reason:string;method?:'local';score?:number;probability?:number;reasons?:string[];route?:string}>()
 private readonly groups=new Map<string,{messages:Observation[];replies:Map<string,Conversation>}>()
 constructor(_ctx:Context,private readonly now=()=>Date.now(),private readonly classify:AttentionClassifier=localAttentionClassifier()){}
 status(channelId:string){return this.decisions.get(channelId)}
 record(channelId:string,event:DirectMessage,reason:string):false {
  if(this.decisions.size>=100&&!this.decisions.has(channelId))this.decisions.delete(this.decisions.keys().next().value!)
  this.decisions.set(channelId,{at:this.now(),groupId:event.qqGroup?.groupId??'',reason})
  return false
 }
 observe(channelId:string,event:DirectMessage):void {
  if(!event.qqGroup)return
  const key=channelId+':'+event.qqGroup.groupId
  let group=this.groups.get(key)
  if(!group){group={messages:[],replies:new Map()};this.groups.set(key,group)}
  const redirect=(!event.qqGroup.mentioned&&event.qqGroup.replyTo!=='self'&&(event.qqGroup.otherMention===true||event.qqGroup.replyTo==='other'))||conversationEnded(event.text)
  if(redirect)group.replies.delete(event.qqGroup.userId)
  group.messages.push({id:event.id,qqId:event.qqGroup.userId,sender:event.qqGroup.senderName||event.qqGroup.userId,text:(event.text||'（附件消息）').slice(0,1200),redirect})
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
  const messages=this.groups.get(channelId+':'+event.qqGroup.groupId)?.messages??[]
  const index=messages.findIndex(m=>m.id===event.id)
  return JSON.stringify(messages.slice(0,index<0?messages.length:index).slice(-16).map(({qqId,sender,text})=>({qqId,sender,text})))
 }
 async shouldReply(channelId:string,event:DirectMessage,companion:Companion,signal:AbortSignal,settings?:Partial<QqSettings>):Promise<boolean> {
  signal.throwIfAborted()
  if(event.qqGroup && isSleeping(companion,this.now()) && !event.qqGroup.mentioned && event.qqGroup.replyTo!=='self')return this.record(channelId,event,'伙伴正在睡眠，暂停群聊自主接话')
  if(!event.qqGroup?.autonomous)return true
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  const owner=qqIdentityRelation(settings,event.sender)?.matched===true
  const recent=group?.replies.get(event.qqGroup.userId)
  const relationship=companion.relationshipText??''
  const addresses=['弟弟','哥哥','姐姐','妹妹','伙伴','小家伙','小朋友','宝贝','老师','搭档'].filter(name=>relationship.includes(name))
  const context:ReplyScoreContext={name:companion.name??'',owner,addresses,affection:owner&&affectionEnabled(companion)?affectionProgress(companion.affection).score:0,now:this.now(),seed:channelId+':'+event.id,...(recent?{recent}:{})}
  let result=routeGroupReply(event,context)
  if(!result){
   let semantic
   try{semantic=await this.classify(event.text,signal)}catch{signal.throwIfAborted()}
   signal.throwIfAborted()
   result=scoreGroupReply(event,{...context,...(semantic?{semantic}:{})})
  }
  this.record(channelId,event,`${result.reply?'进入回复流程':'决定旁听'} · ${result.reasons.join('；')}`)
  Object.assign(this.decisions.get(channelId)!,{method:'local',score:result.score,probability:result.probability,reasons:result.reasons,route:result.route})
  return result.reply
 }
}
