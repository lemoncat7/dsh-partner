import test from 'node:test'
import assert from 'node:assert/strict'
import {ConcernExecutionDispatcher,concernAuthorizationKey} from '../lib/concern-execution.js'
import {ConcernInterruptedError} from '../lib/concern-execution-receipt.js'
const settle=()=>new Promise(r=>setTimeout(r,20))
function fixture(){
 const concern={id:'c',subject:'draft',scopeId:'@local:u',state:'watching',executionInstructions:'只保存待审草稿，不发布',resources:[]}
 const event={concernId:'c',fingerprint:'execution:v1',decision:'keep',event:'draft needed'}
 const state={concernExecutions:[],sessions:[{kind:'local',companionId:'p',sessionId:'s',channelId:'@local',userId:'u'}],delegations:[],planReceipts:[]}
 const store={snapshot:()=>structuredClone(state),update:async fn=>fn(state)}
 const concerns={activity:async()=>({concerns:[concern],observations:[event]})}
 let calls=0,canResume=true,fail=true;const prompts=[]
 const executor={canResumeConcern:async()=>canResume,reconcileConcern:async()=>undefined,executeConcern:async(r,c,p)=>{calls++;prompts.push(p);if(fail)throw new ConcernInterruptedError();await store.update(s=>s.concernExecutions.find(x=>x.id===r.id).status='completed')}}
 return {concern,event,state,store,concerns,executor,prompts,calls:()=>calls,setResume:v=>canResume=v,setFail:v=>fail=v,dispatcher:()=>new ConcernExecutionDispatcher(store,concerns,executor)}
}
test('disposal recovery persists backoff, reuses receipt, reconciles first and stops after three attempts',async()=>{
 const f=fixture();await f.dispatcher().dispatch('p');await settle()
 const r=f.state.concernExecutions[0],id=r.id,original=r.messageId
 assert.equal(r.failureKind,'interrupted');assert.ok(r.retryAt>=Date.now()+299000)
 await f.dispatcher().dispatch('p');assert.equal(f.calls(),1)
 for(let i=1;i<=3;i++){
  r.retryAt=Date.now()-1;await f.dispatcher().dispatch('p');await settle()
  assert.equal(r.id,id);assert.notEqual(r.messageId,original);assert.equal(r.recoveryAttempts,i)
 }
 assert.equal(f.calls(),4);assert.equal(r.retryAt,undefined)
 await f.dispatcher().dispatch('p');assert.equal(f.calls(),4)
 assert.match(f.prompts[1],/宿主中断后的有限自动恢复/);assert.doesNotMatch(f.prompts[1],/用户明确请求/)
 assert.match(f.prompts[1],/有副作用操作禁止重放/);assert.match(f.prompts[1],/刷新来源事实/)
})
for(const change of ['scope','instructions','resources','recordTarget','newInput','stopped','superseded','legacy'])test('automatic resume rejects '+change,async()=>{
 const f=fixture();await f.dispatcher().dispatch('p');await settle();const r=f.state.concernExecutions[0];r.retryAt=0
 if(change==='scope')f.concern.scopeId='@local:other'
 if(change==='instructions')f.concern.executionInstructions='changed'
 if(change==='resources')f.concern.resources=[{kind:'note',locator:'other'}]
 if(change==='recordTarget')f.concern.recordTarget={kind:'note',locator:'other'}
 if(change==='newInput')f.setResume(false)
 if(change==='stopped')f.concern.control='stopped'
 if(change==='superseded')f.event.decision='drop'
 if(change==='legacy')delete r.failureKind
 await f.dispatcher().dispatch('p');assert.equal(f.calls(),1)
})
test('a resumed completed receipt cannot dispatch again; unknown failure is never automatic',async()=>{
 const f=fixture();await f.dispatcher().dispatch('p');await settle();f.state.concernExecutions[0].retryAt=0;f.setFail(false)
 await f.dispatcher().dispatch('p');await settle();await f.dispatcher().dispatch('p');assert.equal(f.calls(),2)
 const g=fixture();g.executor.executeConcern=async()=>{throw Error('unknown outcome')}
 await g.dispatcher().dispatch('p');await settle();assert.equal(g.state.concernExecutions[0].retryAt,undefined)
 assert.equal(g.state.concernExecutions[0].authorizationKey,concernAuthorizationKey(g.concern))
})
