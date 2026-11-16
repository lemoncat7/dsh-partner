import type {DirectMessage} from '../direct/transport.js'
import {qqGroupPeer} from './settings.js'
import type {GroupTaskFocus} from './task-focus.js'
interface Window extends GroupTaskFocus {channelId:string;finishedAt?:number}
/** Ephemeral delivery state spans model work AND the final segmented transport. */
export class GroupReplyWindows {
 private readonly active=new Set<Window>()
 private readonly recent=new Map<string,Window>()
 private key(channel:string,user:string):string{return JSON.stringify([channel,user])}
 begin(channelId:string,userId:string,now=Date.now()):Window {
  const window={channelId,userId,startedAt:now,working:false};this.active.add(window);return window
 }
 sent(window:Window|undefined,now=Date.now()):void {if(window&&this.active.has(window))window.sentAt??=now}
 finish(window:Window|undefined,now=Date.now()):void {
  if(!window||!this.active.delete(window))return
  if(window.sentAt!==undefined){const key=this.key(window.channelId,window.userId);this.recent.delete(key);this.recent.set(key,{...window,finishedAt:now});if(this.recent.size>128)this.recent.delete(this.recent.keys().next().value!)}
 }
 focus(channelId:string,event:DirectMessage,live:GroupTaskFocus|undefined,now=Date.now()):GroupTaskFocus|undefined {
  const group=qqGroupPeer(event.sender)?.groupId
  const windows=[...this.active].filter(w=>w.channelId===channelId&&qqGroupPeer(w.userId)?.groupId===group)
  if(live){
   const window=windows.filter(w=>w.userId===live.userId).at(-1)
   if(window){window.working ||= live.working;if(live.sentAt!==undefined)window.sentAt??=live.sentAt}
   return {...live,...(window?.sentAt!==undefined?{sentAt:window.sentAt}:{})}
  }
  const active=windows.at(-1);if(active)return {...active}
  const key=this.key(channelId,event.sender),recent=this.recent.get(key)
  if(recent&&now-(recent.finishedAt??0)>600000){this.recent.delete(key);return}
  // Already-arrived input waiting in the burst/dispatch buffer belongs to the answered round.
  // Fresh messages after the round finishes are assessed normally, without a cooldown.
  if(recent?.working&&event.receivedAt!==undefined&&event.receivedAt>=recent.startedAt&&event.receivedAt<=(recent.finishedAt??0))return {...recent}
 }
}

interface ReplyOpportunity {channelId:string;userId:string;sourceAt:number;sequence:number}
/** In-memory replacement evidence, independent of the active terminal/task lifecycle. */
export class GroupReplyFreshness {
 private sequence=0
 private readonly latest=new Map<string,ReplyOpportunity>()
 private readonly delivered=new Map<string,ReplyOpportunity>()
 begin(channelId:string,userId:string,sourceAt:number):ReplyOpportunity {
  const item={channelId,userId,sourceAt,sequence:++this.sequence},key=JSON.stringify([channelId,userId]),previous=this.latest.get(key)
  if(!previous||sourceAt>=previous.sourceAt){this.latest.delete(key);this.latest.set(key,item)}
  if(this.latest.size>128)this.latest.delete(this.latest.keys().next().value!)
  return item
 }
 sent(item:ReplyOpportunity|undefined):void {
  if(!item)return
  const key=JSON.stringify([item.channelId,qqGroupPeer(item.userId)?.groupId]),previous=this.delivered.get(key)
  if(!previous||item.sourceAt>=previous.sourceAt){this.delivered.delete(key);this.delivered.set(key,item)}
  if(this.delivered.size>100)this.delivered.delete(this.delivered.keys().next().value!)
 }
 obsolete(item:ReplyOpportunity|undefined,now=Date.now()):'newer-input'|'newer-reply'|undefined {
  if(!item||now-item.sourceAt<=30000)return
  const next=this.latest.get(JSON.stringify([item.channelId,item.userId]))
  if(next&&(next.sourceAt>item.sourceAt||next.sourceAt===item.sourceAt&&next.sequence>item.sequence))return 'newer-input'
  const sent=this.delivered.get(JSON.stringify([item.channelId,qqGroupPeer(item.userId)?.groupId]))
  if(sent&&sent.sequence!==item.sequence&&sent.sourceAt>item.sourceAt)return 'newer-reply'
 }
}
