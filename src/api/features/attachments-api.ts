import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentDeliveryService } from '../../attachments/service.js'
import type { PartnerStore } from '../../store.js'
import { httpError } from '../http.js'

/** Protected by the same authenticated host prefix as the partner workspace. */
export async function dispatchAttachmentsApi(req: IncomingMessage,res: ServerResponse,segments: string[],service: AttachmentDeliveryService,store: PartnerStore): Promise<boolean> {
  if(segments[0]!=='attachments')return false
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
