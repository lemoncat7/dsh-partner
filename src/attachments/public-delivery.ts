import {resolve} from 'node:path'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelSession} from '../domain.js'
import {isInternalTaskNotice,isRequirementDeliveryReceipt} from '../channels/delivery-policy.js'
import {qqSessionTarget} from '../channels/qq/settings.js'

/** Public delivery can return explicit tool artifacts from this conversation, not arbitrary workspace files. */
export function publicArtifactPath(path:string,cwd:string,events:readonly SessionEvent[],routes:readonly ChannelSession[],source:ChannelSession):boolean {
 let origin:ChannelSession|undefined
 const calls=new Map<string,ChannelSession|undefined>()
 const same=(r:ChannelSession|undefined)=>!!r&&r.sessionId===source.sessionId&&r.channelId===source.channelId&&qqSessionTarget(r.userId)===qqSessionTarget(source.userId)
 const matches=(blocks:readonly {type:string;text?:string}[])=>blocks.some(b=>{
  if(b.type!=='text'||!b.text)return false
  try {const data=JSON.parse(b.text);return Array.isArray(data.files)&&data.files.some((f:unknown)=>f&&typeof f==='object'&&'path' in f&&typeof f.path==='string'&&resolve(cwd,f.path)===resolve(cwd,path))}catch{return false}
 })
 for(const e of events){
  if(isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e))origin=undefined
  if(e.type==='user/message'&&e.data.source.kind==='user')origin=routes.find(r=>r.sessionId===source.sessionId&&r.inboundMessageIds?.includes(e.data.id))
  if(e.type==='tool/call')calls.set(e.data.callId,origin)
  if(e.type==='tool/result'&&!e.data.message.isError&&same(calls.get(e.data.message.toolCallId))&&matches(e.data.message.content))return true
  if(e.type==='tool/ptc-dispatch'&&!e.data.isError&&same(calls.get(e.data.rootCallId))&&matches(e.data.content))return true
 }
 return false
}
