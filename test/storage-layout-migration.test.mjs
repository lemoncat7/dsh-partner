import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,readFile,writeFile,rm,readdir,symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { PartnerStore } from '../lib/store.js'
import { createDefaultCompanion } from '../lib/domain.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { PartnerInboxStore } from '../lib/notifications/store.js'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'
import { SplitStatePersistence } from '../lib/storage/split-state.js'
import { storageLayout } from '../lib/storage/layout.js'
import { readStorageConfig,storageConfigPath } from '../lib/storage/bootstrap.js'
import { migrateLayout,verifyInstalledLayout,commitLayoutVersion } from '../lib/storage/migrate-layout.js'
import { runMigrationPath,storageMigrations } from '../lib/storage/migrations/index.js'

async function fixture(fn) {
 const root=await mkdtemp(join(tmpdir(),'partner-layout-'))
 try {
  const statePath=join(root,'public','state.json'),store=await PartnerStore.open(statePath)
  await store.update(s=>{s.companions[0].instructions='PRIVATE_INSTRUCTIONS';s.companions.push({...createDefaultCompanion(),id:'second',name:'Second'})})
  const state=store.snapshot(),owner=state.companions[0].id,layout=storageLayout(statePath,root)
  const memory=new PartnerMemoryStore(root);await memory.hasPendingTurns(owner,'scope')
  const concerns=new PartnerConcernStore(root);await concerns.migrateLegacy(owner,[])
  const inbox=await PartnerInboxStore.open(join(root,'public','partner-inbox.sqlite'))
  inbox.append({id:'notice',companionId:owner,companionName:'Owner',kind:'reply',title:'title',summary:'PRIVATE_NOTICE',createdAt:1});inbox.markRead(['notice'],5)
  inbox.append({id:'system:storage-migration:1',kind:'system',action:'storage-migration',companionId:'',companionName:'伙伴插件',title:'升级',summary:'迁移提醒',createdAt:0});inbox.close()
  const attachments=await AttachmentDeliveryService.open(join(root,'public','attachment-deliveries'))
  const bytes=Buffer.from('PRIVATE_FILE'),id=createHash('sha256').update('file-id').digest('hex')
  const item={id,companionId:owner,sessionId:'session',name:'file.txt',mediaType:'text/plain',kind:'file',size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex'),channel:'sent'}
  await attachments.importExisting(item,bytes);attachments.close()
  await mkdir(join(root,'partner-system','skills','example'),{recursive:true});await writeFile(join(root,'partner-system','skills','example','SKILL.md'),'example')
  await mkdir(join(root,'partners',owner,'memory-backup'),{recursive:true});await writeFile(join(root,'partners',owner,'memory-backup','saved.txt'),'backup')
  await fn({root,statePath,store,state,owner,layout,item,bytes})
 }finally{await rm(root,{recursive:true,force:true})}
}
test('complete migration preserves private data, read receipts, delivery status and activates only at final commit',async()=>fixture(async({root,statePath,state,owner,layout,item,bytes})=>{
 const before=await readFile(statePath,'utf8'),context={statePath,root,state}
 await runMigrationPath(storageMigrations,0,1,context,async(from,to)=>{
  assert.equal((await readStorageConfig(statePath,root)).storageVersion,0)
  await commitLayoutVersion(context,from,to)
 })
 assert.equal((await readStorageConfig(statePath,root)).storageVersion,1)
 await assert.rejects(readFile(statePath),{code:'ENOENT'})
 assert.equal(await readFile(join(context.result.backupPath,'state.json'),'utf8'),before)
 assert.equal(context.result.cleanupPending,0)
 const split=new SplitStatePersistence(layout.publicRoot,layout.privateRoot),store=await PartnerStore.openSplit(split)
 assert.equal(store.snapshot().companions[0].instructions,'PRIVATE_INSTRUCTIONS')
 const publicText=await readFile(join(layout.publicRoot,'state.json'),'utf8');assert.equal(publicText.includes('PRIVATE_INSTRUCTIONS'),false)
 await store.update(s=>{s.companions[0].name='changed';s.companions[1].name='also changed'})
 assert.equal((await PartnerStore.openSplit(split)).snapshot().companions[1].name,'also changed')
 await assert.rejects(readFile(statePath),{code:'ENOENT'})
 const inbox=await PartnerInboxStore.openPartitioned(join(layout.publicRoot,'indexes','inbox.sqlite'),layout.privateRoot)
 assert.equal(inbox.snapshot().items[0].summary,'PRIVATE_NOTICE');assert.equal(inbox.snapshot().items[0].readAt,5)
 assert.equal(inbox.snapshot().items.find(item=>item.kind==='system')?.action,'storage-migration');inbox.close()
 const attachments=await AttachmentDeliveryService.openPartitioned(join(layout.publicRoot,'indexes','attachments'),layout.privateRoot)
 assert.equal(attachments.get(item.id).channel,'sent');assert.deepEqual(await attachments.bytes(item),bytes);attachments.close()
 assert.equal(await readFile(join(layout.privateRoot(owner),'backups','legacy-memory','memory-backup','saved.txt'),'utf8'),'backup')
 const memory=new PartnerMemoryStore(root,'Asia/Shanghai',layout.privateRoot);assert.equal(await memory.hasPendingTurns(owner,'scope'),false)
}))
test('interruption before version commit keeps legacy active and retry recreates only owned targets',async()=>fixture(async({root,statePath,state,layout})=>{
 await migrateLayout(statePath,root,state)
 assert.equal((await readStorageConfig(statePath,root)).storageVersion,0)
 const context={statePath,root,state};await runMigrationPath(storageMigrations,0,1,context,(a,b)=>commitLayoutVersion(context,a,b))
 assert.equal((await readStorageConfig(statePath,root)).storageVersion,1)
 assert.equal((await new SplitStatePersistence(layout.publicRoot,layout.privateRoot).read()).companions.length,2)
}))
test('target collision preserves user files and never commits a version',async()=>fixture(async({root,statePath,state,layout})=>{
 await mkdir(layout.publicRoot);await writeFile(join(layout.publicRoot,'mine.txt'),'keep')
 await assert.rejects(migrateLayout(statePath,root,state),/目标目录已存在/)
 assert.equal(await readFile(join(layout.publicRoot,'mine.txt'),'utf8'),'keep')
 assert.equal((await readStorageConfig(statePath,root)).storageVersion,0)
}))
test('corrupt private snapshot blocks reopening rather than silently using stale state',async()=>fixture(async({root,statePath,state,layout})=>{
 const context={root,statePath,state};await runMigrationPath(storageMigrations,0,1,context,(a,b)=>commitLayoutVersion(context,a,b))
 const manifest=JSON.parse(await readFile(join(layout.publicRoot,'state.json'),'utf8')),ref=manifest.privateRefs[0]
 await writeFile(join(layout.privateRoot(ref.id),'state',ref.hash+'.json'),'corrupt')
 await assert.rejects(PartnerStore.openSplit(new SplitStatePersistence(layout.publicRoot,layout.privateRoot)),/校验失败/)
}))
test('manually raised or unknown version cannot create empty new storage',async()=>fixture(async({root,statePath})=>{
 await assert.rejects(readStorageConfig(statePath,root,1),/缺少迁移/)
 await writeFile(storageConfigPath(statePath),JSON.stringify({storageVersion:99,workspaceRoot:root,transactionId:'bad'}))
 await assert.rejects(readStorageConfig(statePath,root),/高于/)
}))
test('source symlink is refused without activating migration',async()=>fixture(async({root,statePath,state,owner})=>{
 await symlink('/tmp',join(root,'partners',owner,'memory','unsafe'))
 await assert.rejects(migrateLayout(statePath,root,state),/符号链接/)
 assert.equal((await readStorageConfig(statePath,root)).storageVersion,0)
}))
