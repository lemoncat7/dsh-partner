import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {recordingCheckpointTool} from '../lib/recording-snapshot.js'
import {HeartbeatScheduler} from '../lib/heartbeat.js'

test('verified checkpoint survives restart, retries independently and is hidden from normal list',async t=>{
 const root=await mkdtemp(join(tmpdir(),'record-snapshot-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root)
 const item=await store.createExplicit('c','*','跟踪数据','表格',{kind:'note',locator:'n1',label:'记录'})
 const snapshot={data:'[{"id":1,"status":"open"}]',instructions:'更新表格',capturedAt:Date.now()}
 await store.checkpointRecording(item,snapshot)
 const restarted=new PartnerConcernStore(root)
 const queued=await restarted.pendingRecording('c')
 assert.deepEqual(queued.recordingSnapshot,snapshot)
 assert.equal((await restarted.list('c'))[0].recordingSnapshot,undefined)
 assert.equal(await restarted.pendingRecording('other'),undefined)
 assert.deepEqual(await restarted.due('c','*',{includeFuture:true}),[])
 await restarted.settleRecording(queued,false)
 assert.equal(await restarted.pendingRecording('c'),undefined)
 const retry=await restarted.pendingRecording('c',Date.now()+16*60000)
 assert.deepEqual(retry.recordingSnapshot,snapshot)
 await restarted.settleRecording(retry,true)
 assert.equal(await restarted.pendingRecording('c',Date.now()+20*60000),undefined)
 assert.equal((await restarted.list('c'))[0].recordingPending,undefined)
})

test('changing destination cancels old queued data and stale checkpoint cannot restore it',async t=>{
 const root=await mkdtemp(join(tmpdir(),'record-target-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root)
 const item=await store.createExplicit('c','*','跟踪','',{kind:'note',locator:'n1',label:'一'})
 const snapshot={data:'facts',instructions:'table',capturedAt:1}
 await store.checkpointRecording(item,snapshot)
 await store.editExplicit('c',item.id,{subject:item.subject,reason:'',sources:'',expectedUpdatedAt:item.updatedAt,recordTarget:{kind:'note',locator:'n2',label:'二'}})
 assert.equal(await store.pendingRecording('c'),undefined)
 await assert.rejects(store.checkpointRecording(item,snapshot),/配置已改变/)
})

test('checkpoint requires explicit target and complete bounded evidence',async()=>{
 let calls=0
 const tool=recordingCheckpointTool([{id:'c',recordTarget:{kind:'note',locator:'n',label:'note'}}],async()=>{calls++})
 const good={concernId:'c',complete:true,data:'verified rows',instructions:'table'}
 for(const input of [{...good,complete:false},{...good,concernId:'other'},{...good,data:'x'.repeat(100001)}]) await assert.rejects(tool.execute(input,{}))
 assert.equal(calls,0)
 await tool.execute(good,{})
 assert.equal(calls,1)
})

test('sync-only scheduler never records observations or sends notifications',async t=>{
 const root=await mkdtemp(join(tmpdir(),'record-worker-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const concerns=new PartnerConcernStore(root)
 const item=await concerns.createExplicit('c','*','跟踪','',{kind:'note',locator:'n',label:'记录'})
 await concerns.checkpointRecording(item,{data:'verified',instructions:'table',capturedAt:1})
 const companion={id:'c',automation:{heartbeat:{enabled:true}}}
 const state={companions:[companion],sessions:[{id:'route',companionId:'c',channelId:'wechat',userId:'user',sessionId:'session',kind:'channel',approved:true,lastMessageAt:Date.now()}],channels:[{id:'wechat',enabled:true,type:'wechat'}],pairings:[{channelId:'wechat',userId:'user',status:'approved'}]}
 // Use the same route shape accepted by the production scheduler.
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/heartbeat.ts',import.meta.url),'utf8')
 assert.match(source,/recordingOnly/)
 concerns.recordObservations=()=>assert.fail('sync must not re-ingest observations')
 let called=0
 const runtime={heartbeat:async(_c,_r,items)=>{called++;assert.equal(items[0].recordingSnapshot.data,'verified');return {concerns:items,tools:[],candidates:[],startedAt:1,completedAt:2,recording:[{concernId:item.id,state:'synced'}]}},recordHeartbeatActivity:async()=>{}}
 const scheduler=new HeartbeatScheduler({logger:{warn(){}}},{snapshot:()=>state,isCompanionRemoving:()=>false},runtime,{sendProactive:()=>assert.fail('sync must not notify')},concerns)
 const response=await scheduler.trigger('c',{recordingOnly:true})
 assert.equal(response.sent,false)
 assert.equal(called,1)
 assert.equal(await concerns.pendingRecording('c'),undefined)
})
