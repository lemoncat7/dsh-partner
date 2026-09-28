import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'
import { attachmentStorageView, cleanupAttachments } from '../lib/attachments/storage-admin.js'
import { dispatchAttachmentsApi } from '../lib/api/features/attachments-api.js'
import { Readable } from 'node:stream'

test('quota persists; cleanup protects recent, retry and task evidence across owners',async t=>{
  const root=await mkdtemp(join(tmpdir(),'attachment-admin-'))
  const service=await AttachmentDeliveryService.openPartitioned(join(root,'index'),id=>join(root,id))
  t.after(async()=>{service.close();await rm(root,{recursive:true,force:true})})
  service.setLimitMiB(1024)
  assert.throws(()=>service.setLimitMiB(0))
  const reopened=await AttachmentDeliveryService.openPartitioned(join(root,'index'),id=>join(root,id))
  assert.equal(reopened.limitMiB,1024);reopened.close()
  const data=Buffer.from('evidence'),hash=createHash('sha256').update(data).digest('hex')
  for(let n=1;n<=5;n++)await service.importExisting({id:String(n).repeat(64),companionId:n===5?'b':'a',sessionId:'s',name:'result.md',mediaType:'text/markdown',kind:'file',size:data.length,hash,channel:n===2?'failed':'none',createdAt:n===3?Date.now():1},data)
  const state={companions:[{id:'a',name:'A'},{id:'b',name:'B'}],tasks:[{status:'review',resultAttachmentIds:['4'.repeat(64)]}],requirements:[]}
  const store={snapshot:()=>state,isCompanionRemoving:()=>false}
  const view=await attachmentStorageView(service,store)
  assert.equal(view.count,5);assert.equal(view.eligibleCount,2);assert.equal(view.owners.length,2)
  const result=await cleanupAttachments(service,store,view.items.map(i=>i.id))
  assert.deepEqual(result,{removed:2,freedBytes:data.length*2,skipped:3,failed:0})
  assert.equal((await readFile(join(root,'a','deliveries','4'.repeat(64)))).toString(),'evidence')
  assert.equal((await attachmentStorageView(service,store)).count,3)
  assert.equal((await cleanupAttachments(service,store,['1'.repeat(64)])).skipped,1)
  const request=(method,body,authorized=true)=>Object.assign(Readable.from([JSON.stringify(body)]),{method,url:'/attachments/storage',headers:authorized?{'x-dsh-partner-request':'1'}:{}})
  const response=()=>({setHeader(){},end(value){this.value=JSON.parse(value)}})
  await assert.rejects(dispatchAttachmentsApi(request('PUT',{limitMiB:2048},false),response(),['attachments','storage'],service,store),/header/)
  await assert.rejects(dispatchAttachmentsApi(request('PUT',{limitMiB:-1}),response(),['attachments','storage'],service,store),/额度/)
  await assert.rejects(dispatchAttachmentsApi(request('POST',{ids:['2'.repeat(64)]}),response(),['attachments','cleanup'],service,store),/确认/)
  await dispatchAttachmentsApi(request('PUT',{limitMiB:2048}),response(),['attachments','storage'],service,store)
  assert.equal(service.limitMiB,2048)
  const res=response()
  await dispatchAttachmentsApi({method:'GET',url:'/attachments/storage?owner=b',headers:{}},res,['attachments','storage'],service,store)
  assert.equal(res.value.items.length,0);assert.equal(res.value.count,3)
})
