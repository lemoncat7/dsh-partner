import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {HeartbeatScheduler} from '../lib/heartbeat.js'

test('delete removes internal records, keeps external files and prevents cached resurrection',async t=>{
 const root=await mkdtemp(join(tmpdir(),'delete-concern-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root)
 const batch={batchId:'b',source:'ui'}
 const candidates=[{subject:'test watch',reason:'test',operation:'upsert',priority:1,confidence:1,watchKind:'auto',watchQuery:'test'}]
 const applied=await store.ingestCandidates('c','*',candidates,'explicit',Date.now(),batch)
 const item=applied.created[0]
 await writeFile(join(root,'external.md'),'keep')
 const observation={concernId:item.id,changed:true,event:'change',evidence:'verified',source:'local',relevance:1,confidence:1,actionability:1}
 await store.recordObservations([item],[observation])
 const current=(await store.list('c'))[0]
 await assert.rejects(store.remove('c',item.id,-1),/变化/)
 await store.remove('other',item.id,current.updatedAt)
 assert.equal((await store.list('c')).length,1)
 await store.remove('c',item.id,current.updatedAt)
 await store.remove('c',item.id,current.updatedAt)
 assert.deepEqual((await store.activity('c')).observations,[])
 assert.deepEqual(await store.list('c',undefined,true),[])
 const replay=await store.ingestCandidates('c','*',candidates,'explicit',Date.now(),batch)
 assert.deepEqual(replay.created,[]);assert.deepEqual(replay.entries,[])
 assert.deepEqual((await store.recordObservations([item],[observation])).observations,[])
 assert.equal(await readFile(join(root,'external.md'),'utf8'),'keep')
 const db=new DatabaseSync(join(root,'partners/c/concerns/concerns.sqlite'),{readOnly:true})
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM concern_audit WHERE concern_id = ?').get(item.id).n,0);db.close()
 assert.notEqual((await store.createExplicit('c','*','test watch')).id,item.id)
})

test('archived cleanup is paginated and heartbeat deletion cannot race an active run',async t=>{
 const root=await mkdtemp(join(tmpdir(),'archived-concern-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root);const item=await store.createExplicit('c','*','old')
 await store.act('c',item.id,'ignore');assert.equal((await store.archived('c')).items[0].id,item.id)
 let release
 const scheduler=new HeartbeatScheduler({}, {snapshot:()=>({companions:[{id:'c'}]}),isCompanionRemoving:()=>false},{},{},store)
 scheduler.run=()=>new Promise(resolve=>{release=resolve})
 const running=scheduler.trigger('c',{manual:true})
 await assert.rejects(scheduler.removeConcern('c',item.id,item.updatedAt),/正在执行/)
 release({checked:false,sent:false});await running
 const current=(await store.archived('c')).items[0]
 await scheduler.removeConcern('c',item.id,current.updatedAt)
 assert.deepEqual((await store.archived('c')).items,[])
 assert.equal(scheduler.isRunning('c'),false)
})
