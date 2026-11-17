import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {cleanupWorkCatalog} from '../lib/execution/catalog-cleanup.js'
import {patchSubagentCatalog} from '../ops/host/subagent-catalog-cleanup.mjs'
const type='plugin:dsh-partner/subagent-cleaned'
function fixture(){
 const parent=Session.create('parent');parent.append('subagent/catalog',{version:3,childId:'child',childCreatedAt:1,mode:'continuable',label:'task',name:'agent-1'});parent.append('subagent/catalog',{version:3,childId:'working',childCreatedAt:2,mode:'continuable',label:'still running',name:'agent-2'})
 const run={id:'run',sessionId:'child',ownerCompanionId:'owner',status:'completed',sessionCleanup:{deletedAt:1},background:{sourceSessionId:'parent',deliveredAt:2,result:{text:'done',files:[]}}}
 const state={companions:[{id:'owner',characterCard:{enabled:true}}],executionRuns:[run],sessions:[{sessionId:'parent',companionId:'owner'}]},events=[...parent.snapshotEvents()];let live=true,patched=true,flushes=0,closes=0,appends=0
 const listing=()=>{const rows=live?parent.snapshotEvents():events;return rows.filter(e=>e.type==='subagent/catalog').map(e=>({id:e.data.childId})).filter(x=>!patched||!rows.some(e=>pluginRecordOf(e)?.type===type&&e.data.childId===x.id))}
 const handle={header:{id:'parent'},read:async()=>({events:[...events]}),append:async rows=>{assert.equal(rows[0].seq,events.length);events.push(...rows);appends++},flush:async()=>{flushes++},close:async()=>{closes++}}
 const persistence={flush:handle.flush,open:async(id,access)=>{assert.equal(id,'parent');assert.equal(access,'write');return handle}}
 const ctx={get:name=>({sessions:{get:()=>live?parent:undefined},sessionPersistence:persistence,subagents:{listDescendants:async()=>listing()}})[name]},store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 return {ctx,store,run,parent,state,events,listing,setLive:v=>live=v,setPatched:v=>patched=v,counts:()=>({flushes,closes,appends})}
}
test('completed deleted work is removed from discovery via an ignorable append; other children and history stay',async()=>{
 const f=fixture(),before=JSON.stringify(f.parent.snapshotEvents());assert.equal(await cleanupWorkCatalog(f.ctx,f.store,f.run),true)
 assert.equal(JSON.stringify(f.parent.snapshotEvents().slice(0,2)),before);assert.deepEqual(f.listing(),[{id:'working'}])
 const record=f.parent.snapshotEvents().at(-1);assert.equal(record.ignorable,true);assert.equal(pluginRecordOf(record).type,type)
 assert.ok(f.run.sessionCleanup.catalogRemovedAt);assert.equal(await cleanupWorkCatalog(f.ctx,f.store,f.run),false);assert.equal(f.parent.snapshotEvents().length,3)
})
test('running, undelivered, not physically deleted and foreign records cannot retire a catalog entry',async()=>{
 for(const change of [f=>f.run.status='running',f=>delete f.run.sessionCleanup.deletedAt,f=>delete f.run.background.deliveredAt,f=>f.state.sessions[0].companionId='other']){
  const f=fixture();change(f);assert.equal(await cleanupWorkCatalog(f.ctx,f.store,f.run),false);assert.equal(f.parent.snapshotEvents().length,2)
 }
 const f=fixture();assert.equal(await cleanupWorkCatalog(f.ctx,f.store,{...f.run,ownerCompanionId:'foreign'}),false)
})
test('unloaded parent uses a write lease and preserves a contiguous native append rather than rewriting the log',async()=>{
 const f=fixture();f.setLive(false);assert.equal(await cleanupWorkCatalog(f.ctx,f.store,f.run),true)
 assert.equal(f.events.length,3);assert.equal(f.events.at(-1).seq,2);assert.deepEqual(f.counts(),{flushes:1,closes:1,appends:1})
})
test('unsupported native discovery stays pending and retries without duplicate cleanup records',async()=>{
 const f=fixture();f.setPatched(false);await assert.rejects(cleanupWorkCatalog(f.ctx,f.store,f.run),/宿主仍保留/);assert.equal(f.run.sessionCleanup.catalogRemovedAt,undefined)
 f.setPatched(true);assert.equal(await cleanupWorkCatalog(f.ctx,f.store,f.run),true);assert.equal(f.parent.snapshotEvents().length,3)
})
test('host patch is narrow, idempotent and fails closed on unknown implementations',()=>{
 const source='function reserveName(parent, requested) {return this.names.reserve(parent, catalogNames(this.host.catalogOf(parent.session)), requested); }\nconst subagentCatalogProjectionDefinition = {\n\tapply: (state,event)=>{\n\t\tif (event.type !== "subagent/catalog" || event.seq < state.inheritedEventCount) return state;\n return state;},\n stateVersion: 6,\n};'
 const out=patchSubagentCatalog(source);assert.match(out,/stateVersion: 7/);assert.match(out,/event.ignorable === true/);assert.match(out,/event.seq >= state.inheritedEventCount/);assert.equal(patchSubagentCatalog(out),out);assert.throws(()=>patchSubagentCatalog('unknown'),/Unrecognized/)
})

test('periodic cleanup backfills discovery for work whose log was already removed',async()=>{
 const {PartnerWorkSessionCleanup}=await import('../lib/execution/session-cleanup.js')
 const f=fixture();await PartnerWorkSessionCleanup.prototype.sweep.call({ctx:f.ctx,store:f.store,running:false})
 assert.deepEqual(f.listing(),[{id:'working'}]);assert.ok(f.run.sessionCleanup.catalogRemovedAt)
 const replay=Session.create('replay',f.parent.snapshotEvents());assert.ok(replay.snapshotEvents().some(e=>pluginRecordOf(e)?.type===type))
 assert.equal(replay.deriveMessages().length,0)
})


test('retired sibling names stay reserved when allocating after cleanup, including inherited and in-flight boundaries',()=>{
 const original='function reserveName(parent, requested) {return this.names.reserve(parent, catalogNames(this.host.catalogOf(parent.session)), requested); }\nconst subagentCatalogProjectionDefinition = {\n apply: (state,event)=>{\n\t\tif (event.type !== "subagent/catalog" || event.seq < state.inheritedEventCount) return state;\n return state;},\n stateVersion: 6,\n};'
 const patched=patchSubagentCatalog(original),body=patched.slice(patched.indexOf('{')+1,patched.indexOf('}\nconst subagentCatalogProjectionDefinition'))
 const reserve=new Function('catalogNames','parent','requested',body)
 const events=[{type:'subagent/catalog',seq:0,data:{name:'agent-9'}},{type:'subagent/catalog',seq:1,data:{name:'agent-1'}},{type:'plugin:dsh-partner/subagent-cleaned',seq:2,data:{childId:'done'}},{type:'subagent/catalog',seq:3,data:{name:'agent-2'}}]
 const parent={session:{snapshotEvents:()=>events,isOwnSeq:seq=>seq>=1}}
 const runtime={host:{catalogOf:()=>[{name:'agent-2'}]},names:{reserve:(p,names,requested)=>{assert.equal(p,parent);assert.deepEqual([...names].sort(),['agent-1','agent-2']);if(requested){if(names.has(requested))throw Error('duplicate');return requested}let n=1;while(names.has('agent-'+n))n++;return 'agent-'+n}}}
 assert.equal(reserve.call(runtime,entries=>new Set(entries.map(e=>e.name)),parent),'agent-3')
 assert.throws(()=>reserve.call(runtime,entries=>new Set(entries.map(e=>e.name)),parent,'agent-1'),/duplicate/)
 assert.equal(patchSubagentCatalog(patched),patched)
})
