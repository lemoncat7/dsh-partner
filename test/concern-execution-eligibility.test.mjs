import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerConcernStore} from '../lib/concern-store.js'
import {parseConcernObservations} from '../lib/agent-runtime.js'
import {parseObservationStatuses} from '../lib/observation-executor.js'
import {concernObservationPrompt} from '../lib/autonomy.js'
import {PartnerStore} from '../lib/store.js'
import {ConcernExecutionDispatcher} from '../lib/concern-execution.js'

test('baseline work survives parsing and storage with stable deduplication and no notification',async t=>{
 const root=await mkdtemp(join(tmpdir(),'concern-eligibility-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerConcernStore(root)
 let item=await store.createExplicit('c','*','检查来源','',undefined,'生成待审核草稿，不发布')
 assert.match(concernObservationPrompt([item]),/生成待审核草稿，不发布/)
 const row={concernId:item.id,checkStatus:'completed',outcome:'baseline_initialized',changed:false,executionNeeded:true,executionKey:'https://example.org/object|draft|v1',event:'待处理对象',evidence:'已核实且交付历史无此对象',source:'https://example.org/object',relevance:1,confidence:1,actionability:1}
 const parse=r=>{const raw=JSON.stringify({observations:[r]});return parseConcernObservations(raw,parseObservationStatuses(raw,new Set([item.id])).completed)}
 let result=await store.recordObservations([item],parse(row),Date.now(),false)
 assert.equal(result.observations.length,1);assert.equal(result.notifications.length,0)
 assert.match(result.observations[0].fingerprint,/^execution:/)
 item=(await store.list('c'))[0]
 await store.recordObservations([item],parse({...row,event:'不同措辞',evidence:'重查同一对象'}),Date.now(),false)
 assert.equal((await store.activity('c')).observations.length,1)
 for(const outcome of ['already_processed','blocked'])assert.throws(()=>parse({...row,outcome,checkStatus:outcome==='blocked'?'blocked':'completed'}),/矛盾/)
 assert.throws(()=>parse({...row,executionKey:''}),/标识/)
 const disabled=await store.createExplicit('c','*','只观察')
 await store.recordObservations([disabled],[{...parse(row)[0],concernId:disabled.id}],Date.now(),false)
 assert.equal((await store.activity('c')).observations.length,1)
})

test('baseline pending work dispatches once, explicit observation-only work does not',async t=>{
 const root=await mkdtemp(join(tmpdir(),'concern-dispatch-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json')),id=store.snapshot().companions[0].id
 await store.update(s=>s.sessions.push({id:'r',companionId:id,kind:'local',channelId:'@local',userId:'u',sessionId:'s',lastMessageAt:0}))
 const concerns=new PartnerConcernStore(root)
 let item=await concerns.createExplicit(id,'@local:u','处理候选','',undefined,'生成草稿，不发布')
 const candidate={concernId:item.id,changed:false,executionNeeded:true,executionKey:'object|draft|v1',event:'未处理对象',evidence:'已核实未交付',source:'https://example.org/item',relevance:1,confidence:1,actionability:1}
 await concerns.recordObservations([item],[candidate],Date.now(),false)
 let calls=0
 const executor={executeConcern:async receipt=>{calls++;await store.update(s=>{s.concernExecutions.find(r=>r.id===receipt.id).status='completed'})}}
 const dispatcher=new ConcernExecutionDispatcher(store,concerns,executor)
 await dispatcher.dispatch(id);await new Promise(r=>setTimeout(r,30));assert.equal(calls,1)
 item=(await concerns.list(id))[0]
 await concerns.recordObservations([item],[{...candidate,event:'同对象换措辞',evidence:'再次核实'}],Date.now(),false)
 await dispatcher.dispatch(id);assert.equal(calls,1)
 item=(await concerns.list(id))[0]
 await concerns.recordObservations([item],[{...candidate,changed:true,executionNeeded:false,event:'只观察不执行'}],Date.now(),false)
 await dispatcher.dispatch(id);assert.equal(calls,1)
 assert.equal(store.snapshot().tasks.length,0)
})
