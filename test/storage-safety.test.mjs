import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, rmdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { createDefaultCompanion } from '../lib/domain.js'
import { acquireStorageLease } from '../lib/storage/lease.js'
import { StorageCoordinator } from '../lib/storage/coordinator.js'
import { SplitStatePersistence } from '../lib/storage/split-state.js'
import { migrateLayout,verifyInstalledLayout,commitLayoutVersion } from '../lib/storage/migrate-layout.js'
import { readStorageConfig,storageConfigPath } from '../lib/storage/bootstrap.js'
import { storageLayout } from '../lib/storage/layout.js'

async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'partner-safety-'));try{const path=join(root,'public','state.json');const store=await PartnerStore.open(path);await fn(root,path,store)}finally{await rm(root,{recursive:true,force:true})}}
test('runtime lease excludes a second instance and releases cleanly',async()=>fixture(async(root,path)=>{
 const release=await acquireStorageLease(path)
 await assert.rejects(acquireStorageLease(path),/另一个插件实例/)
 release();release();const next=await acquireStorageLease(path);next()
}))
test('failed second private write leaves the previous global transaction readable',async()=>fixture(async(root,path,store)=>{
 await store.update(s=>{s.companions.push({...createDefaultCompanion(),id:'two'})})
 const layout=storageLayout(path,root),split=new SplitStatePersistence(layout.publicRoot,layout.privateRoot)
 await split.write(store.snapshot())
 const before=await split.read(),changed=store.snapshot();changed.companions[0].name='new';changed.companions[1].name='new too'
 const broken=new SplitStatePersistence(layout.publicRoot,id=>{if(id==='two')throw Error('injected disk failure');return layout.privateRoot(id)})
 await assert.rejects(broken.write(changed),/disk failure/)
 assert.deepEqual(await split.read(),before)
}))
test('failed activation config commit leaves version zero and old data intact',async()=>fixture(async(root,path,store)=>{
 const before=await readFile(path,'utf8'),context={statePath:path,root,state:store.snapshot()}
 await migrateLayout(path,root,context.state);await verifyInstalledLayout(context)
 await mkdir(storageConfigPath(path))
 await assert.rejects(commitLayoutVersion(context,0,1))
 await rmdir(storageConfigPath(path))
 assert.equal((await readStorageConfig(path,root)).storageVersion,0)
 assert.equal(await readFile(path,'utf8'),before)
 await migrateLayout(path,root,context.state);await verifyInstalledLayout(context);await commitLayoutVersion(context,0,1)
 assert.equal((await readStorageConfig(path,root)).storageVersion,1)
}))
test('coordinator rejects running agents, concurrent API calls and stale versions before stopping runtime',async()=>fixture(async(root,path,store)=>{
 let stopped=0,busy=true
 const service=new StorageCoordinator(path,root,0,{snapshot:()=>store.snapshot(),busy:()=>busy,quiesce:async()=>{stopped++},restart:async()=>{},report:()=>{}})
 await assert.rejects(service.migrate(0),/执行中/);busy=false
 const a=service.enterRequest(),b=service.enterRequest()
 await assert.rejects(service.migrate(0),/页面请求/);a();b()
 await assert.rejects(service.migrate(1),/版本已变化/)
 assert.equal(stopped,0)
}))
