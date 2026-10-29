import type { PartnerReply } from '../../channel-message.js'

export interface QqLatencySample {
 at:number
 messageId:string
 outcome:'processing'|'replied'|'silent'|'steered'|'not-admitted'|'failed'
 beforeHandleMs?:number
 decisionMs?:number
 decisionMethod?:'local'
 decisionScore?:number
 agentMs?:number
 sendMs?:number
 totalMs?:number
 agent?:Record<string,number>
}
// Timings belong to the live reply only, never to persistent chat payloads.
const replyTimings=new WeakMap<PartnerReply,Record<string,number>>()
export function setReplyTiming(reply:PartnerReply,timing:Record<string,number>):void {replyTimings.set(reply,timing)}
export function getReplyTiming(reply:PartnerReply):Record<string,number>|undefined {return replyTimings.get(reply)}

export class QqLatencyHistory {
 private readonly channels=new Map<string,QqLatencySample[]>()
 start(channelId:string,messageId:string,receivedAt?:number):QqLatencySample {
  const at=Date.now(),sample:QqLatencySample={at,messageId,outcome:'processing',...(receivedAt===undefined?{}:{beforeHandleMs:Math.max(0,at-receivedAt)})}
  const history=this.channels.get(channelId)??[]
  history.push(sample);if(history.length>20)history.shift()
  this.channels.delete(channelId);this.channels.set(channelId,history)
  if(this.channels.size>100)this.channels.delete(this.channels.keys().next().value!)
  return sample
 }
 view(channelId:string):QqLatencySample[] {return structuredClone(this.channels.get(channelId)??[])}
}
