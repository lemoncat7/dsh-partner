import type { SessionEvent } from '@deepseek-ai/dsh-session'
function object(value: unknown): Record<string,any> | undefined {
  try { const v=typeof value==='string'?JSON.parse(value):value; return v&&typeof v==='object'&&!Array.isArray(v)?v:undefined } catch { return undefined }
}
export function attachmentDeliveryMeta(value:unknown):{kind:'partner-attachment-delivered-v1';originRouteId:string}|null {
  const v=object(value)
  return v?.channel==='sent'&&v.conversation==='attachment_recorded'&&typeof v.originRouteId==='string'&&v.originRouteId?{kind:'partner-attachment-delivered-v1',originRouteId:v.originRouteId}:null
}
export function deliveredAttachment(event:SessionEvent):string|undefined {
  if(event.type!=='tool/result'&&event.type!=='tool/ptc-dispatch')return
  if(!event.data||(event.type==='tool/result'?event.data.message?.isError:event.data.isError))return
  const meta=event.data.meta as {kind?:string;originRouteId?:unknown}|undefined
  return meta?.kind==='partner-attachment-delivered-v1'&&typeof meta.originRouteId==='string'?meta.originRouteId:undefined
}

/** Compact, confirmed transport facts; prose about sending is never evidence. */
export function attachmentDeliveryReceipt(event:SessionEvent):{deliveryId:string;name:string;routeId:string;at:number;status:'sent'}|undefined {
 const routeId=deliveredAttachment(event)
 if(!routeId)return
 const data=event.type==='tool/result'?event.data.message:event.type==='tool/ptc-dispatch'?event.data:undefined
 for(const block of data?.content??[]){
  if(block.type!=='text')continue
  const value=object(block.text)
  if(value?.channel==='sent'&&value.conversation==='attachment_recorded'&&value.originRouteId===routeId&&typeof value.deliveryId==='string'&&value.deliveryId.length<=200&&typeof value.name==='string'&&value.name.length<=300)
   return {deliveryId:value.deliveryId,name:value.name,routeId,at:event.time,status:'sent'}
 }
}
export function recentAttachmentDeliveries(events:readonly SessionEvent[],routeId:string,limit=6){
 const found=new Map<string,NonNullable<ReturnType<typeof attachmentDeliveryReceipt>>>()
 for(let i=events.length-1;i>=0&&found.size<limit;i--){const receipt=attachmentDeliveryReceipt(events[i]!);if(receipt?.routeId===routeId&&!found.has(receipt.deliveryId))found.set(receipt.deliveryId,receipt)}
 return [...found.values()].reverse()
}
