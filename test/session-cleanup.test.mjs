import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {cleanupWorkSession,PartnerWorkSessionCleanup} from '../lib/execution/session-cleanup.js'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'partner-log-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const id='partner-run-owned',directory=join(root,id),file=join(directory,'session.v4.jsonl.zstd'),artifact=join(root,'result.md')
 await mkdir(directory);await writeFile(file,'work log');await writeFile(artifact,'actual result')
 const run={id:'r',sessionId:id,ownerCompanionId:'c',status:'completed',outputSummary:'actual result'},state={executionRuns:[run],sessions:[]};let active=false,opened=0,closed=0
 const persistence={stat:async()=>({header:{id,cwd:root,parentSession:'parent'},location:{kind:'jsonl',path:file}}),open:async()=>{opened++;return {close:async()=>{closed++}}}}
 const ctx={get:n=>n==='agents'?{get:()=>active?{}:undefined}:n==='sessionPersistence'?persistence:undefined}
 const store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 return {run,state,ctx,store,persistence,file,directory,artifact,setActive:x=>{active=x},leases:()=>[opened,closed]}
}
test('completed owned work log is physically removed once, preserving result files',async t=>{
 const f=await fixture(t);assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),true)
 await assert.rejects(access(f.file));await access(f.artifact);assert.deepEqual(f.leases(),[1,1]);assert.ok(f.run.sessionCleanup.deletedAt)
 assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false)
})
test('main conversations, live work and undelivered results are never deleted',async t=>{
 const f=await fixture(t)
 f.state.sessions.push({sessionId:f.run.sessionId});assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false);f.state.sessions=[]
 f.run.status='running';assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false);f.run.status='completed'
 f.setActive(true);assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false);f.setActive(false)
 f.run.background={sourceSessionId:'parent',result:{text:'result',files:[]}};assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false)
 f.run.status='failed';delete f.run.background.result;f.run.error='Error: 后台产物不在本任务工作目录内';assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false)
 await access(f.file)
})
test('foreign records and mismatched persisted ancestry fail closed',async t=>{
 const f=await fixture(t);assert.equal(await cleanupWorkSession(f.ctx,f.store,{...f.run,ownerCompanionId:'foreign'}),false)
 f.run.background={sourceSessionId:'another-parent',deliveredAt:1,result:{text:'done',files:[]}}
 await assert.rejects(cleanupWorkSession(f.ctx,f.store,f.run),/父会话不匹配/);await access(f.file)
})
test('native child tracking follows only partner ancestry and saves result before cleanup',async()=>{
 const hooks=new Map(),state={companions:[{id:'c',characterCard:{enabled:true}}],executionRuns:[],sessions:[{sessionId:'parent',companionId:'c'}]},store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 const cleaner=new PartnerWorkSessionCleanup({on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name)},logger:{warn(){}}},store)
 await hooks.get('subagent/start')({id:'foreign',local:true,parentSessionId:'unrelated'});assert.equal(state.executionRuns.length,0)
 await hooks.get('subagent/start')({id:'child',local:true,parentSessionId:'parent'});assert.equal(state.executionRuns[0].ownerCompanionId,'c')
 await hooks.get('subagent/end')({id:'child',stopReason:'completed',lastAssistantMessage:[{type:'text',text:'saved complete result'}]})
 assert.equal(state.executionRuns[0].outputSummary,'saved complete result');assert.equal(state.executionRuns[0].status,'completed')
 cleaner.close();assert.equal(hooks.size,0)
})


test('canceled work retains its log and artifacts; only explicit discard permits reclamation',async t=>{
 const f=await fixture(t);f.run.status='canceled';f.run.background={sourceSessionId:'parent'}
 assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false);await access(f.file);await access(f.artifact);assert.deepEqual(f.leases(),[0,0])
 f.run.background.discardedAt=Date.now();assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),true);await assert.rejects(access(f.file));await access(f.artifact)
})


test('ordinary native child sessions are not adopted or reclaimed by the role workflow',async()=>{
 const hooks=new Map(),state={companions:[{id:'c',characterCard:{enabled:false}}],executionRuns:[],sessions:[{sessionId:'parent',companionId:'c'}]},store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 const cleaner=new PartnerWorkSessionCleanup({on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name)},logger:{warn(){}}},store)
 await hooks.get('subagent/start')({id:'native-normal',local:true,parentSessionId:'parent'})
 assert.deepEqual(state.executionRuns,[])
 cleaner.close()
})

test('a child finishing sweeps eligible siblings and filters only retired catalog entries',async()=>{
 const session=Session.create('parent'),hooks=new Map()
 const terminal={id:'sibling',sessionId:'finished-sibling',status:'completed',ownerCompanionId:'c',sessionCleanup:{parentSessionId:'parent'}}
 const paused={id:'paused',sessionId:'paused',status:'canceled',ownerCompanionId:'c',background:{sourceSessionId:'parent'}}
 const other={...terminal,id:'unrelated',sessionId:'unrelated',sessionCleanup:{parentSessionId:'other-parent'}}
 const prior={...terminal,id:'old-ghost',sessionId:'old-ghost',sessionCleanup:{parentSessionId:'parent',deletedAt:1}}
 const state={companions:[{id:'c',characterCard:{enabled:true}}],executionRuns:[terminal,paused,other,prior],sessions:[{sessionId:'parent',companionId:'c'}]}
 const store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 const def={key:'subagentCatalog',stateVersion:6,stateSchema:{parse:({items})=>({items})},apply:state=>state,wire:{view:state=>state.items}}
 const context={on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name)},logger:{warn(msg){assert.fail(msg)}},get:key=>key==='agents'?{get:id=>id==='parent'?{session}:undefined}:key==='sessionPersistence'?{stat:async()=>undefined,open:async()=>{throw Error('missing child')}}:key==='sessionProjections'?{registrations:new Map([['subagentCatalog',{def}]])}:undefined}
 const cleaner=new PartnerWorkSessionCleanup(context,store)
 const catalog={items:[{id:'finished-sibling'},{id:'paused'},{id:'old-ghost'}]}
 assert.deepEqual(def.wire.view(catalog).map(row=>row.id),['finished-sibling','paused'])
 await hooks.get('subagent/start')({id:'child',local:true,parentSessionId:'parent'})
 await hooks.get('subagent/end')({id:'child',stopReason:'completed'})
 await cleaner.sweep('parent')
 assert.ok(terminal.sessionCleanup.deletedAt)
 assert.ok(state.executionRuns.at(-1).sessionCleanup.deletedAt)
 assert.equal(other.sessionCleanup.deletedAt,undefined)
 assert.equal(paused.sessionCleanup,undefined)
 assert.deepEqual(def.wire.view(catalog).map(row=>row.id),['paused'])
 const refresh=session.snapshotEvents().find(e=>e.type==='plugin:dsh-partner/subagent-cleaned')
 const durable=def.stateSchema.parse(def.apply(catalog,refresh))
 assert.deepEqual(durable.partnerRetired,['finished-sibling'])
 state.executionRuns=state.executionRuns.filter(run=>run.id!==terminal.id)
 assert.deepEqual(def.wire.view(durable).map(row=>row.id),['paused'])
 appendPluginRecord(session,'plugin:dsh-partner/subagent-cleaned',{version:1,childId:'paused',runId:'fake',ownerCompanionId:'c'})
 assert.equal(def.apply(catalog,session.snapshotEvents().at(-1)),catalog)
 cleaner.close()
 assert.equal(def.wire.view(catalog),catalog.items)
})

test('waiting for materials retains the native session even after its notification was delivered',async t=>{
 const f=await fixture(t);f.run.status='waiting'
 f.run.background={sourceSessionId:'parent',deliveredAt:1,result:{text:'请补底图',files:[]},review:{kind:'completion',doneAt:1,decision:{action:'wait'}}}
 assert.equal(await cleanupWorkSession(f.ctx,f.store,f.run),false)
 await access(f.file);assert.equal(f.run.sessionCleanup,undefined)
})
