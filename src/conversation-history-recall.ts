import {attachmentDeliveryReceipt} from './attachments/delivery-receipt.js'
import {chatReplyFromEvent} from './chat/protocol.js'
import {appendPluginRecord,pluginRecordOf,type Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelSession} from './domain.js'
import {memoryTerms} from './memory-retrieval.js'

type HistoryHit={id:string;at:number;user:string;assistant:string;score:number;deliveries:NonNullable<ReturnType<typeof attachmentDeliveryReceipt>>[]}
type InputOrigin={messageId:string;routeId:string;channelId:string;userId:string}
export function recordInputOrigin(session:Session,data:InputOrigin):void {appendPluginRecord(session,'plugin:dsh-partner/input-origin',data)}
function inputOrigins(events:readonly SessionEvent[]):InputOrigin[]{
 return events.flatMap(e=>{const record=pluginRecordOf(e);if(record?.type!=='plugin:dsh-partner/input-origin')return [];const d=record.data as Partial<InputOrigin>|null;return d&&['messageId','routeId','channelId','userId'].every(k=>typeof d[k as keyof InputOrigin]==='string')?[d as InputOrigin]:[]})
}
declare module '@deepseek-ai/dsh-session/types' {
 interface PluginRecordMap { 'plugin:dsh-partner/input-origin': InputOrigin }
}

/** Search original user-authored turns in this session, including off-window history.
 * Never search another channel's shared-session turns or reinterpret summaries as facts. */
export function recallConversationHistory(events:readonly SessionEvent[],routes:readonly ChannelSession[],sessionId:string,origin:ChannelSession|undefined,query:string,limit=6){
 const terms=memoryTerms(query),hits:Array<HistoryHit>=[]
 const durableOrigins=new Map(inputOrigins(events).map(d=>[d.messageId,d]))
 const shared=routes.some(r=>r.sessionId===sessionId&&r.kind==='channel')
 let current:HistoryHit|undefined
 const finish=()=>{if(current){const text=(current.user+'\n'+current.assistant+'\n'+current.deliveries.map(d=>d.name).join(' ')).normalize('NFKC').toLocaleLowerCase();current.score=terms.filter(t=>text.includes(t)).length;if(current.score)hits.push(current)}current=undefined}
 const text=(content:readonly {type:string;text?:string}[])=>content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n')
 for(const e of events){
  if(e.type==='turn/start'||e.type==='turn/end'){finish();continue}
  if(e.type==='user/message'&&e.data.source.kind==='user'&&e.surfaceOp==='append'){
   finish()
   const durable=durableOrigins.get(e.data.id)
   const route=routes.find(r=>r.kind==='channel'&&r.sessionId===sessionId&&r.inboundMessageIds?.includes(e.data.id))
   // Channel IDs retain only a bounded recent-origin index. Unknown old channel
   // turns are not assumed to belong to the current caller.
   if(origin?.kind==='channel' ? (durable ? durable.routeId!==origin.id||durable.channelId!==origin.channelId||durable.userId!==origin.userId : route?.id!==origin.id) : durable ? !routes.some(r=>r.id===durable.routeId&&r.kind==='local'&&r.sessionId===sessionId) : route!==undefined||shared)continue
   current={id:e.data.id,at:e.time,user:text(e.data.content).slice(0,12000),assistant:'',score:0,deliveries:[]}
  }else if(current&&e.type==='assistant/message'&&e.surfaceOp==='append'){
   if(!e.data.message.content.some(b=>b.type==='tool-call'))current.assistant=(current.assistant+'\n'+text(e.data.message.content)).trim().slice(-12000)
  }else if(current&&(e.type==='tool/ptc-dispatch'||e.type==='tool/result')){
   const chat=chatReplyFromEvent(e)
   if(chat&&!chat.transportCallId){const speech=[text(chat.parts),chat.spokenText].filter(Boolean).join('\n');if(speech)current.assistant=(current.assistant+'\n'+speech).trim().slice(-12000)}
   const receipt=attachmentDeliveryReceipt(e)
   if(receipt?.routeId===origin?.id&&receipt&&!current.deliveries.some(d=>d.deliveryId===receipt.deliveryId)&&current.deliveries.length<8)current.deliveries.push(receipt)
  }
 }
 finish()
 const excerpt=(value:string)=>{const lower=value.toLocaleLowerCase(),at=Math.min(...terms.map(t=>lower.indexOf(t)).filter(i=>i>=0));const start=Number.isFinite(at)?Math.max(0,at-200):0;return (start?'…':'')+value.slice(start,start+1600)+(value.length>start+1600?'…':'')}
 return hits.sort((a,b)=>b.score-a.score||b.at-a.at).slice(0,limit).map(({score,deliveries,...hit})=>({...hit,...(deliveries.length?{deliveries}:{}),user:excerpt(hit.user),assistant:excerpt(hit.assistant)}))
}

/** Preserve local input provenance too, so raw recall works after route indexes roll off. */
export function recordLocalInputOrigins(session:Session,messages:readonly {id:string;source:{kind:string}}[],routes:readonly ChannelSession[]):void {
 const local=routes.find(r=>r.kind==='local'&&r.sessionId===session.id)
 if(!local||typeof session.append!=='function')return
 const known=new Set(inputOrigins(session.snapshotEvents()).map(d=>d.messageId))
 for(const message of messages){
  if(message.source.kind!=='user'||known.has(message.id)||routes.some(r=>r.sessionId===session.id&&r.kind==='channel'&&r.inboundMessageIds?.includes(message.id)))continue
  recordInputOrigin(session,{messageId:message.id,routeId:local.id,channelId:local.channelId,userId:local.userId})
 }
}
