import test from 'node:test'
import assert from 'node:assert/strict'
import {PartnerSchedulerService} from '../lib/scheduler/service.js'
import {createDefaultCompanion} from '../lib/domain.js'

const flush=()=>new Promise(r=>setImmediate(r))
function fixture(policy='queue',schedule={kind:'interval',minutes:5}) {
 let release
 const gate=new Promise(r=>{release=r}), calls=[],listeners=new Set()
 const state={companions:[{...createDefaultCompanion(),id:'c',capabilities:['schedules']}],tasks:[],delegations:[],executionRuns:[],schedules:[{
  id:'s',companionId:'c',title:'test',prompt:'isolated',schedule,enabled:true,destroySessionAfterRun:true,
  overlapPolicy:policy,timeoutMinutes:10,nextRunAt:Date.now(),createdAt:Date.now(),updatedAt:Date.now(),
 }]}
 const store={snapshot:()=>structuredClone(state),hasCapability:()=>true,
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn)},
  async update(fn){fn(state);for(const listener of listeners)listener(state);return structuredClone(state)}}
 const scheduler=new PartnerSchedulerService(store,{async execute(input){calls.push(input);if(calls.length===1)await gate}},'Asia/Shanghai')
 return {scheduler,state,calls,release}
}
for(const policy of ['queue','skip'])test(`${policy}: repeated polls consume an occurrence only once`,async()=>{
 const real=Date.now,start=Date.parse('2026-11-24T09:00:00+08:00');let now=start;Date.now=()=>now
 const f=fixture(policy)
 try{
  await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);assert.equal(f.calls.length,1)
  now+=15000;await f.scheduler.tick();assert.equal(f.calls.length,1)
  now+=5000;f.release();await flush()
  assert.equal(f.calls.length,1);assert.equal(f.state.schedules[0].nextRunAt,start+300000)
  now=start+300000;await f.scheduler.tick();await flush();assert.equal(f.calls.length,2)
 }finally{f.release();await f.scheduler.close();Date.now=real}
})
for(const policy of ['queue','skip'])test(`${policy}: a genuinely overlapping occurrence follows its configured policy`,async()=>{
 const real=Date.now,start=Date.parse('2026-11-24T09:00:00+08:00');let now=start;Date.now=()=>now
 const f=fixture(policy)
 try{
  await f.scheduler.tick();now+=300000;await f.scheduler.tick()
  assert.equal(f.calls.length,1);assert.equal(f.state.schedules[0].nextRunAt,start+600000)
  f.release();await flush();assert.equal(f.calls.length,policy==='queue'?2:1)
  assert.equal(f.state.schedules[0].nextRunAt,start+600000)
 }finally{f.release();await f.scheduler.close();Date.now=real}
})
test('daily task completion cannot skip the next day',async()=>{
 const real=Date.now;let now=Date.parse('2026-11-24T09:00:00+08:00');Date.now=()=>now
 const f=fixture('skip',{kind:'daily',hour:9,minute:0})
 try{
  await f.scheduler.tick();now+=15000;await f.scheduler.tick();f.release();await flush()
  assert.equal(f.state.schedules[0].nextRunAt,Date.parse('2026-11-25T09:00:00+08:00'))
 }finally{f.release();await f.scheduler.close();Date.now=real}
})
test('shutdown waits for the executor and never launches queued work',async()=>{
 const f=fixture();let closed=false
 try{
  await f.scheduler.tick();await f.scheduler.trigger('s')
  const closing=f.scheduler.close().then(()=>{closed=true})
  await flush();assert.equal(closed,false);assert.equal(f.calls[0].signal.aborted,true)
  f.release();await closing;assert.equal(f.calls.length,1)
  await assert.rejects(f.scheduler.trigger('s'),/停止/)
 }finally{f.release();await f.scheduler.close()}
})
test('finishing an old run preserves a concurrent schedule edit',async()=>{
 const f=fixture('skip')
 try{
  await f.scheduler.tick()
  await f.scheduler.update('s',{schedule:{kind:'interval',minutes:30}})
  const next=f.state.schedules[0].nextRunAt
  f.release();await flush();assert.equal(f.state.schedules[0].nextRunAt,next)
 }finally{f.release();await f.scheduler.close()}
})
test('shutdown also waits for continuation execution and keeps its durable state resumable',async()=>{
 const f=fixture();let release,entered=false,closed=false
 const gate=new Promise(r=>{release=r}),entry=f.state.schedules[0]
 entry.continuation={state:'waiting',taskKey:'key',externalTaskId:'job',originSessionId:'main',check:'read only',nextStep:'finish',attempts:0,maxAttempts:3,deadlineAt:Date.now()+60000}
 f.scheduler.continuations.configure({async execute(){entered=true;await gate},async notify(){assert.fail('closing must suppress delivery')}})
 try{
  const running=f.scheduler.continuations.run('s');await flush();assert.equal(entered,true)
  const closing=f.scheduler.close().then(()=>{closed=true})
  await flush();assert.equal(closed,false);release();await running;await closing
  assert.equal(entry.continuation.state,'running','next startup must recover the original durable check')
 }finally{release();f.release();await f.scheduler.close()}
})
