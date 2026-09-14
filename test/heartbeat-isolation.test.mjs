import test from 'node:test'
import assert from 'node:assert/strict'
import { HeartbeatScheduler } from '../lib/heartbeat.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const failure of ['blocked', 'throw']) test(`healthy notifications are sent in the same batch as a ${failure} concern`, async () => {
  const companion = {id:'c',automation:{heartbeat:{enabled:true,intervalMinutes:30,dailyLimit:0}}}
  const state={companions:[companion],heartbeatStates:[{companionId:'c',consecutiveFailures:10,sentCount:0}],sessions:[{companionId:'c',channelId:'w',userId:'u',lastMessageAt:0}],channels:[{id:'w',enabled:true}],pairings:[{channelId:'w',userId:'u',status:'approved'}]}
  const deferred=[], sent=[], mentioned=[]
  const scheduler=new HeartbeatScheduler({}, {snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}, {
    heartbeat:async (_c,_r,items)=>{
      if(items[0].id==='bad' && failure==='throw')throw Error('unavailable')
      return {concerns:items,candidates:[],startedAt:0,completedAt:1,...(items[0].id==='bad'?{blocked:['bad'],blockedReasons:{bad:'unavailable'}}:{})}
    },recordHeartbeatActivity:async()=>{},
  },{sendProactive:async (_c,_u,message)=>sent.push(message)}, {
    pendingNotifications:async()=>[],due:async()=>[{id:'bad',subject:'bad'},{id:'good',subject:'good'}],
    deferFailedCheck:async item=>deferred.push(item.id),
    recordObservations:async()=>({observations:[],notifications:[{id:'event',event:'verified change'}]}),
    markMentioned:async (_c,ids)=>mentioned.push(...ids),
  })
  const result=await scheduler.trigger('c',{manual:true})
  assert.equal(result.sent,true)
  assert.match(result.reason,/unavailable/)
  assert.deepEqual(sent,['verified change'])
  assert.deepEqual(mentioned,['event'])
  assert.deepEqual(deferred,['bad'])
  assert.equal(state.heartbeatStates[0].consecutiveFailures,0)
  assert.ok(state.heartbeatStates[0].nextCheckAt < Date.now()+31*60_000)
  await scheduler.close()
})

test('failed-check delay persists independently and stale attempts cannot override it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'concern-retry-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const store=new PartnerConcernStore(root)
  const a=await store.createExplicit('c','*','failed source')
  const b=await store.createExplicit('c','*','healthy source')
  const retryAt=Date.now()+30*60_000
  await store.deferFailedCheck(a,retryAt)
  await store.deferFailedCheck(a,retryAt+60_000)
  const restored=await new PartnerConcernStore(root).list('c')
  assert.equal(restored.find(item=>item.id===a.id).nextCheckAt,retryAt)
  assert.equal(restored.find(item=>item.id===b.id).nextCheckAt,b.nextCheckAt)
  assert.equal(restored.find(item=>item.id===a.id).lastCheckedAt,a.lastCheckedAt)
})

test('commits individual concerns, continues after failure and retries only unfinished work', async () => {
  const companion = { id: 'c', automation: { heartbeat: { enabled: true, intervalMinutes: 30, dailyLimit: 0 } } }
  const state = { companions: [companion], heartbeatStates: [],
    sessions: [{ companionId: 'c', channelId: 'w', userId: 'u', lastMessageAt: 0 }],
    channels: [{ id: 'w', enabled: true }], pairings: [{ channelId: 'w', userId: 'u', status: 'approved' }] }
  const saved = new Set(), calls = [], events = []
  let failing = true
  const concerns = {
    deferFailedCheck: async (item, at) => { assert.equal(item.id, 'b'); assert.ok(at > Date.now()) },
    pendingNotifications: async () => [],
    due: async () => ['a', 'b', 'c'].filter(id => !saved.has(id)).map(id => ({ id, subject: id })),
    recordObservations: async items => {
      assert.equal(items.length, 1)
      saved.add(items[0].id); events.push('save:' + items[0].id)
      return { observations: [], notifications: [] }
    },
  }
  const scheduler = new HeartbeatScheduler({}, { snapshot: () => state, isCompanionRemoving: () => false, update: async fn => fn(state) }, {
    heartbeat: async (_companion, _route, items) => {
      assert.equal(items.length, 1)
      const id = items[0].id
      calls.push(id); events.push('run:' + id)
      if (id === 'b' && failing) throw Error('model unavailable')
      return { concerns: items, candidates: [], startedAt: 0, completedAt: 1 }
    },
    recordHeartbeatActivity: async () => {},
  }, {}, concerns)
  const partial = await scheduler.trigger('c', { manual: true })
  assert.match(partial.reason, /model unavailable/)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.deepEqual(events, ['run:a', 'save:a', 'run:b', 'run:c', 'save:c'])
  assert.equal(state.heartbeatStates[0].consecutiveFailures, 0)
  failing = false
  const result = await scheduler.trigger('c', { manual: true })
  assert.equal(result.checked, true)
  assert.deepEqual(calls, ['a', 'b', 'c', 'b'])
  assert.equal(state.heartbeatStates[0].consecutiveFailures, 0)
  await scheduler.close()
})
