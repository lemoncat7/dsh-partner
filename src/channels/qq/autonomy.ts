import type { Context } from '@deepseek-ai/cordis'
import type { Companion } from '../../domain.js'
import type { DirectMessage } from '../direct/transport.js'
import type { QqSettings } from './settings.js'
import { qqIdentityRelation } from './identity-binding.js'
import { affectionEnabled, affectionProgress } from '../../character/affection.js'
import { scoreGroupReply } from './reply-rules.js'

/** Local, bounded group attention. No model call and no tool execution. */
export class QqGroupAutonomy {
 private readonly decisions=new Map<string,{at:number;groupId:string;reason:string;method?:'local';score?:number;probability?:number;reasons?:string[]}>()
 private readonly groups=new Map<string,{messages:Array<{sender:string;qqId:string;text:string}>;replied?:{at:number;userId:string;text:string}}>()
 constructor(_ctx:Context,private readonly now=()=>Date.now()){}
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
  if(!group){group={messages:[]};this.groups.set(key,group)}
  if(group.replied&&group.replied.userId!==event.qqGroup.userId)delete group.replied
  group.messages.push({qqId:event.qqGroup.userId,sender:event.qqGroup.senderName||event.qqGroup.userId,text:(event.text||'（附件消息）').slice(0,1200)})
  group.messages=group.messages.slice(-16)
  if(this.groups.size>100)this.groups.delete(this.groups.keys().next().value!)
 }
 /** Only a successful reply establishes a short conversational continuation window. */
 replied(channelId:string,event:DirectMessage,text=''):void {
  if(!event.qqGroup)return
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  if(group?.messages.at(-1)?.qqId===event.qqGroup.userId)group.replied={at:this.now(),userId:event.qqGroup.userId,text:text.slice(0,1200)}
 }
 context(channelId:string,event:DirectMessage):string {
  if(!event.qqGroup?.autonomous)return ''
  return JSON.stringify(this.groups.get(channelId+':'+event.qqGroup.groupId)?.messages.slice(0,-1)??[])
 }
 async shouldReply(channelId:string,event:DirectMessage,companion:Companion,signal:AbortSignal,settings?:Partial<QqSettings>):Promise<boolean> {
  signal.throwIfAborted()
  if(!event.qqGroup?.autonomous)return true
  const group=this.groups.get(channelId+':'+event.qqGroup.groupId)
  const owner=qqIdentityRelation(settings,event.sender)?.matched===true
  const result=scoreGroupReply(event,{name:companion.name,owner,affection:owner&&affectionEnabled(companion)?affectionProgress(companion.affection).score:0,now:this.now(),seed:channelId+':'+(event.id??JSON.stringify([event.qqGroup.groupId,event.qqGroup.userId,event.text])),...(group?.replied?.userId===event.qqGroup.userId?{recent:group.replied}:{})})
  this.record(channelId,event,`本地评分 ${result.score} 分 · ${result.reply?'决定接话':'决定旁听'}（接话概率 ${Math.round(result.probability*100)}%）`)
  Object.assign(this.decisions.get(channelId)!,{method:'local',score:result.score,probability:result.probability,reasons:result.reasons})
  return result.reply
 }
}
