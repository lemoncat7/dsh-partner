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
  if(recent&&event.receivedAt!==undefined&&event.receivedAt>=recent.startedAt&&event.receivedAt<=(recent.finishedAt??0))return {...recent}
 }
}
