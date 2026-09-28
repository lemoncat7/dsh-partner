import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentDeliveryService } from '../../attachments/service.js'
import type { PartnerStore } from '../../store.js'
import { httpError, mutation, readObject, sendJson } from '../http.js'
import { attachmentStorageView, cleanupAttachments } from '../../attachments/storage-admin.js'

/** Protected by the same authenticated host prefix as the partner workspace. */
export async function dispatchAttachmentsApi(req: IncomingMessage,res: ServerResponse,segments: string[],service: AttachmentDeliveryService,store: PartnerStore): Promise<boolean> {
  if(segments[0]!=='attachments')return false
  if(segments[1]==='storage'&&segments.length===2){
    if(req.method==='GET'){
      const query=new URL(req.url??'/', 'http://localhost').searchParams
      const view=await service.serial('storage',()=>attachmentStorageView(service,store))
      const owner=query.get('owner'),days=Number(query.get('days')||0),offset=Number(query.get('offset')||0)
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isFinite(days)||days<0)throw httpError(400,'筛选条件无效')
      const filtered=view.items.filter(i=>(!owner||i.companionId===owner)&&(!days||i.createdAt>0&&i.createdAt<Date.now()-days*86400000))
      sendJson(res,200,{...view,filteredCount:filtered.length,items:filtered.slice(offset,offset+30)});return true
    }
    if(req.method==='PUT'){
      mutation(req);const body=await readObject(req)
      if(typeof body.limitMiB!=='number'||!Number.isSafeInteger(body.limitMiB)||body.limitMiB<64||body.limitMiB>1048576)throw httpError(400,'总额度须为 64–1048576 MiB 的整数')
      await service.serial('storage',async()=>service.setLimitMiB(body.limitMiB as number))
      sendJson(res,200,{limitMiB:service.limitMiB});return true
    }
  }
  if(segments[1]==='cleanup'&&segments.length===2&&req.method==='POST'){
    mutation(req);const body=await readObject(req)
    if(body.confirm!==true||!Array.isArray(body.ids)||!body.ids.length||body.ids.length>100||body.ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw httpError(400,'请明确确认并选择最多 100 个附件')
    sendJson(res,200,await cleanupAttachments(service,store,body.ids as string[]));return true
  }
  if(req.method!=='GET'||segments.length!==2)throw httpError(404,'unknown attachment endpoint')
  const item=service.get(segments[1]!)
  if(!item||!store.snapshot().companions.some(c=>c.id===item.companionId)||store.isCompanionRemoving(item.companionId))throw httpError(404,'附件不存在')
  const data=await service.bytes(item)
  res.setHeader('content-type',item.mediaType)
  res.setHeader('content-disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/'/g,'%27')}`)
  res.setHeader('cache-control','private, no-store')
  res.setHeader('x-content-type-options','nosniff')
  res.setHeader('content-length',data.length)
  res.end(data);return true
}
