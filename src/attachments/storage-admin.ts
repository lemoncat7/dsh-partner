import type { AttachmentDeliveryService } from './service.js'
import type { PartnerStore } from '../store.js'
import type { AttachmentStorageView, AttachmentCleanupResult } from './storage-types.js'

export async function attachmentStorageView(service: AttachmentDeliveryService, store: PartnerStore): Promise<AttachmentStorageView> {
  const state=store.snapshot(), entries=await service.storedEntries()
  // Includes explicit IDs and historical text-based attachment references.
  const references=JSON.stringify([...state.tasks.filter(t=>t.status!=='done'),...(state.requirements??[]).filter(r=>!r.archivedAt||!r.notifiedAt)])
  const owners:AttachmentStorageView['owners']=[]
  const items=entries.map(item=>{
    const name=state.companions.find(c=>c.id===item.companionId)?.name??item.companionId
    let owner=owners.find(o=>o.id===item.companionId)
    if(!owner){owner={id:item.companionId,name,bytes:0,count:0,directory:item.directory};owners.push(owner)}
    owner.bytes+=item.size;owner.count++
    const protectedReason=store.isCompanionRemoving(item.companionId)?'伙伴正在删除':item.channel==='pending'||item.channel==='failed'?'等待发送或重试':Date.now()-item.createdAt<300000?'刚创建，暂时保护':references.includes(item.id)?'任务或需求仍在引用':undefined
    return {...item,companionName:name,...(protectedReason?{protectedReason}:{})}
  }).sort((a,b)=>b.createdAt-a.createdAt)
  const eligible=items.filter(i=>!i.protectedReason)
  return {limitMiB:service.limitMiB,usedBytes:items.reduce((n,i)=>n+i.size,0),count:items.length,eligibleBytes:eligible.reduce((n,i)=>n+i.size,0),eligibleCount:eligible.length,filteredCount:items.length,items,owners}
}

export async function cleanupAttachments(service:AttachmentDeliveryService,store:PartnerStore,ids:string[]):Promise<AttachmentCleanupResult>{
  return service.serial('storage',async()=>{
    const result:AttachmentCleanupResult={removed:0,freedBytes:0,skipped:0,failed:0}
    for(const id of new Set(ids)){
      // Recheck references for each deletion, including changes during filesystem I/O.
      const item=(await attachmentStorageView(service,store)).items.find(i=>i.id===id)
      if(!item||item.protectedReason){result.skipped++;continue}
      try{await service.removeStored(service.get(id)!);result.removed++;result.freedBytes+=item.size}catch{result.failed++}
    }
    return result
  })
}
