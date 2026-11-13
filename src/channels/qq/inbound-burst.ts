import {setTimeout as delay} from 'node:timers/promises'
import type {DirectMessage} from '../direct/transport.js'
import type {DirectDispatcher} from '../direct/dispatcher.js'

interface Burst { messages:DirectMessage[]; first:number; last:number }
/** Debounce one group speaker in its existing dispatch lane; never delay polling or private chats. */
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
    // Keep references to another person separate from a direct exchange.
    const key=JSON.stringify([first.targetId,first.sender,first.qqGroup.otherMention===true,first.qqGroup.replyToId??''])
    const previous=this.pending.get(key),now=Date.now()
    if(previous&&previous.messages.length+fresh.length<=16&&now-previous.first<this.maxMs){
      previous.messages.push(...fresh);previous.last=now;fresh.forEach(m=>this.ids.add(m.id));return
    }
    const burst:Burst={messages:[...fresh],first:now,last:now}
    this.pending.set(key,burst);fresh.forEach(m=>this.ids.add(m.id))
    try {
      this.dispatcher.enqueue(fresh.map(m=>m.id),'steer',async prepared=>{
        try {
          for(;;){const remaining=Math.min(burst.last+this.quietMs,burst.first+this.maxMs)-Date.now();if(remaining<=0)break;await delay(remaining,undefined,{signal:this.signal})}
          if(this.pending.get(key)===burst)this.pending.delete(key)
          await run(burst.messages,prepared)
        } finally {
          if(this.pending.get(key)===burst)this.pending.delete(key)
          burst.messages.forEach(m=>this.ids.delete(m.id))
        }
      },first.targetId||first.sender)
    } catch(error) {
      if(this.pending.get(key)===burst)this.pending.delete(key)
      fresh.forEach(m=>this.ids.delete(m.id));throw error
    }
  }
}

/** Classify the whole burst, retaining any direct invitation and all original messages for receipt handling. */
export function groupBurstEvent(events:readonly DirectMessage[],text:string):DirectMessage {
  const first=events[0]!
  if(!first.qqGroup)return first
  const self=events.find(e=>e.qqGroup?.replyTo==='self')
  return {...first,text,qqGroup:{...first.qqGroup,mentioned:events.some(e=>e.qqGroup?.mentioned),...(self?{replyTo:'self' as const,hasReply:true}:{})}}
}
