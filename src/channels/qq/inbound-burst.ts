import {setTimeout as delay} from 'node:timers/promises'
import type {DirectMessage} from '../direct/transport.js'
import type {DirectDispatcher} from '../direct/dispatcher.js'

interface Burst { key:string; messages:DirectMessage[]; first:number; last:number; sealed?:true }

function withinSourceWindow(events:readonly DirectMessage[],previous:readonly DirectMessage[],maxMs:number):boolean {
  const before=previous[0]!,tail=previous.at(-1)!,first=events[0]!,last=events.at(-1)!
  for(const field of ['timestamp','receivedAt'] as const){
    const from=before[field],end=tail[field],next=first[field],to=last[field]
    if(from===undefined||end===undefined||next===undefined||to===undefined)continue
    if(Number.isFinite(from)&&Number.isFinite(end)&&Number.isFinite(next)&&Number.isFinite(to)){
      if(next<end||to-from>maxMs)return false
    }
  }
  return true
}

/** Debounce only adjacent messages from the same speaker within a group. */
export class QqGroupBursts {
  private readonly pending=new Map<string,Burst>()
  private readonly ids=new Set<string>()
  constructor(private readonly dispatcher:DirectDispatcher,private readonly signal:AbortSignal,
    private readonly quietMs=600,private readonly maxMs=2400) {
    signal.addEventListener('abort',()=>{this.pending.clear();this.ids.clear()},{once:true})
  }
  has(id:string):boolean { return this.ids.has(id) }
  enqueue(messages:readonly DirectMessage[],run:(messages:DirectMessage[],prepared:()=>void)=>Promise<void>):void {
    this.signal.throwIfAborted()
    const fresh=messages.filter(m=>!this.ids.has(m.id))
    if(!fresh.length)return
    const first=fresh[0]!
    if(!first.qqGroup||fresh.some(m=>!m.qqGroup||m.sender!==first.sender||m.targetId!==first.targetId))throw Error('群聊合并只能包含同一群的同一发言人')
    const room=first.qqGroup.groupId
    const key=JSON.stringify([first.sender,first.qqGroup.otherMention===true,first.qqGroup.replyToId??''])
    const previous=this.pending.get(room),now=Date.now()
    if(previous?.key===key&&previous.messages.length+fresh.length<=16&&now-previous.first<this.maxMs&&
      withinSourceWindow(fresh,previous.messages,this.maxMs)){
      previous.messages.push(...fresh);previous.last=now;fresh.forEach(m=>this.ids.add(m.id));return
    }
    if(previous)previous.sealed=true
    const burst:Burst={key,messages:[...fresh],first:now,last:now}
    this.pending.set(room,burst);fresh.forEach(m=>this.ids.add(m.id))
    try {
      this.dispatcher.enqueue(fresh.map(m=>m.id),'steer',async prepared=>{
        try {
          while(!burst.sealed){const remaining=Math.min(burst.last+this.quietMs,burst.first+this.maxMs)-Date.now();if(remaining<=0)break;await delay(remaining,undefined,{signal:this.signal})}
          if(this.pending.get(room)===burst)this.pending.delete(room)
          await run(burst.messages,prepared)
        } finally {
          if(this.pending.get(room)===burst)this.pending.delete(room)
          burst.messages.forEach(m=>this.ids.delete(m.id))
        }
      },first.targetId||'group:'+room)
    } catch(error) {
      if(this.pending.get(room)===burst)this.pending.delete(room)
      fresh.forEach(m=>this.ids.delete(m.id));throw error
    }
  }
}

/** Classify the whole burst, retaining any direct invitation and all original messages for receipt handling. */
export function groupBurstEvent(events:readonly DirectMessage[],text:string):DirectMessage {
  const first=events[0]!
  if(!first.qqGroup)return first
  const self=events.find(e=>e.qqGroup?.replyTo==='self')
  return {...first,text,media:events.flatMap(e=>e.media??[]),qqGroup:{...first.qqGroup,mentioned:events.some(e=>e.qqGroup?.mentioned),...(self?{replyTo:'self' as const,hasReply:true}:{})}}
}
