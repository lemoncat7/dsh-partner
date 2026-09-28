import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AttachmentDeliveryService } from './service.js'

/** Startup-only conversion. Copy + verify + commit before removing each old snapshot.
 * Existing IDs and channel retry state are preserved; interrupted copies are resumable.
 * Keep empty legacy databases as migration provenance, never move workspace originals.
 */
export async function openSharedAttachmentStorage(publicRoot:string, privateRoot:(id:string)=>string):Promise<AttachmentDeliveryService>{
  const target=join(publicRoot,'attachment-deliveries')
  const existed=existsSync(join(target,'deliveries.sqlite'))
  const shared=await AttachmentDeliveryService.openGrouped(target)
  const legacyRoot=join(publicRoot,'indexes','attachments')
  if(!existsSync(join(legacyRoot,'index.sqlite')))return shared
  let legacy:AttachmentDeliveryService|undefined
  try{
    legacy=await AttachmentDeliveryService.openPartitioned(legacyRoot,privateRoot)
    if(!existed)shared.setLimitMiB(legacy.limitMiB)
    for(const entry of await legacy.storedEntries()){
      const {directory:_,...item}=entry
      const current=shared.get(item.id)
      if(current){
        if(current.hash!==item.hash||current.size!==item.size||current.companionId!==item.companionId)throw Error('公共附件与旧索引冲突，已保留旧副本')
        await shared.bytes(current)
      }else{
        await shared.importExisting(item,await legacy.bytes(item))
        await shared.bytes(item)
      }
      await legacy.removeStored(item)
    }
    return shared
  }catch(error){shared.close();throw error}
  finally{legacy?.close()}
}
