import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {cleanupWorkSession,PartnerWorkSessionCleanup} from '../lib/execution/session-cleanup.js'
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
