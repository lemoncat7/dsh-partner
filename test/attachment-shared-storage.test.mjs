import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'
import { openSharedAttachmentStorage } from '../lib/attachments/shared-storage.js'

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'shared-deliveries-')),publicRoot=join(root,'public'),privateRoot=id=>join(root,'partners',id,'.partner')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const data=Buffer.from('original evidence'),hash=createHash('sha256').update(data).digest('hex')
  const item={id:'a'.repeat(64),companionId:'one',sessionId:'session',name:'a.md',mediaType:'text/markdown',kind:'file',size:data.length,hash,channel:'failed',channelRouteId:'original-channel',createdAt:12345678}
  const legacy=await AttachmentDeliveryService.openPartitioned(join(publicRoot,'indexes','attachments'),privateRoot)
  await legacy.importExisting(item,data);legacy.setLimitMiB(1536);legacy.close()
  return {root,publicRoot,privateRoot,data,item}
}
test('centralizes snapshots, preserves IDs, retry route, date and quota; reopening never resurrects cleaned files',async t=>{
  const f=await fixture(t)
  const shared=await openSharedAttachmentStorage(f.publicRoot,f.privateRoot)
  try{
    assert.deepEqual(shared.get(f.item.id),f.item);assert.equal(shared.limitMiB,1536)
    assert.deepEqual(await shared.bytes(f.item),f.data)
    assert.equal((await shared.outbound(f.item)).path,join(f.publicRoot,'attachment-deliveries','one',f.item.id))
    await assert.rejects(access(join(f.privateRoot('one'),'deliveries',f.item.id)),{code:'ENOENT'})
    await shared.removeOwner('unrelated');assert.ok(shared.get(f.item.id))
    await shared.removeOwner('one');assert.equal(shared.get(f.item.id),undefined)
  }finally{shared.close()}
  const reopened=await openSharedAttachmentStorage(f.publicRoot,f.privateRoot)
  try{assert.equal(reopened.get(f.item.id),undefined);assert.equal(reopened.limitMiB,1536)}finally{reopened.close()}
})
test('resumes a copied-but-unindexed file without deleting the wrong contents',async t=>{
  const f=await fixture(t),target=join(f.publicRoot,'attachment-deliveries','one')
  await mkdir(target,{recursive:true});await writeFile(join(target,f.item.id),f.data)
  const shared=await openSharedAttachmentStorage(f.publicRoot,f.privateRoot)
  try{assert.deepEqual(await shared.bytes(f.item),f.data)}finally{shared.close()}
})
test('corrupt destination stops migration and retains source for recovery',async t=>{
  const f=await fixture(t),target=join(f.publicRoot,'attachment-deliveries','one')
  await mkdir(target,{recursive:true});await writeFile(join(target,f.item.id),'corrupt')
  await assert.rejects(openSharedAttachmentStorage(f.publicRoot,f.privateRoot),/校验失败/)
  assert.deepEqual(await readFile(join(f.privateRoot('one'),'deliveries',f.item.id)),f.data)
})
test('resumes committed destination after old file was removed but index still exists',async t=>{
  const f=await fixture(t)
  const shared=await AttachmentDeliveryService.open(join(f.publicRoot,'attachment-deliveries'))
  await shared.importExisting(f.item,f.data);shared.setLimitMiB(2048);shared.close()
  await rm(join(f.privateRoot('one'),'deliveries',f.item.id))
  const resumed=await openSharedAttachmentStorage(f.publicRoot,f.privateRoot)
  try{assert.deepEqual(resumed.get(f.item.id),f.item);assert.equal(resumed.limitMiB,2048)}finally{resumed.close()}
})
test('flat shared files move under owner IDs; reopening and cleanup preserve isolation',async t=>{
  const f=await fixture(t),root=join(f.root,'flat')
  const flat=await AttachmentDeliveryService.open(root)
  const second={...f.item,id:'b'.repeat(64),companionId:'two'}
  await flat.importExisting(f.item,f.data);await flat.importExisting(second,f.data);flat.setLimitMiB(2048);flat.close()
  let grouped=await AttachmentDeliveryService.openGrouped(root)
  assert.equal(grouped.limitMiB,2048)
  assert.deepEqual(await grouped.bytes(f.item),f.data)
  await assert.rejects(access(join(root,f.item.id)),{code:'ENOENT'})
  assert.deepEqual(await readFile(join(root,'one',f.item.id)),f.data)
  grouped.close();grouped=await AttachmentDeliveryService.openGrouped(root)
  try{await grouped.removeOwner('one');assert.deepEqual(await grouped.bytes(second),f.data);assert.equal(grouped.get(f.item.id),undefined)}finally{grouped.close()}
})
test('conflicting grouped copy refuses overwrite and leaves original intact',async t=>{
  const f=await fixture(t),root=join(f.root,'conflict')
  const flat=await AttachmentDeliveryService.open(root)
  await flat.importExisting(f.item,f.data);flat.close()
  await mkdir(join(root,'one'));await writeFile(join(root,'one',f.item.id),'corrupt')
  await assert.rejects(AttachmentDeliveryService.openGrouped(root),/校验失败/)
  assert.deepEqual(await readFile(join(root,f.item.id)),f.data)
})
test('unsafe owner IDs cannot escape the shared root',async t=>{
  const f=await fixture(t),root=join(f.root,'unsafe')
  const flat=await AttachmentDeliveryService.open(root)
  await flat.importExisting({...f.item,companionId:'../outside'},f.data);flat.close()
  await assert.rejects(AttachmentDeliveryService.openGrouped(root),/编号无效/)
  assert.deepEqual(await readFile(join(root,f.item.id)),f.data)
})
