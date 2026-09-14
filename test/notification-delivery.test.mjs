import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {NotificationDelivery} from '../lib/channels/notification-delivery.js'
import {notificationRoutes} from '../lib/channels/notification-route.js'

const targets=[{channelId:'a',userId:'alice'},{channelId:'b',userId:'bob'}]
test('notification settings fan out; recent mode replaces legacy per-contact routing',()=>{
  const state={companions:[{id:'c',notificationDelivery:{mode:'selected',targets}}],channels:targets.map(t=>({id:t.channelId,companionId:'c',enabled:true})),pairings:targets.map((t,i)=>({...t,status:'approved',lastInboundAt:i+1,deliveryTarget:targets[0]}))}
  assert.deepEqual(notificationRoutes(state,'a','alice'),targets)
  assert.deepEqual(notificationRoutes(state,'local','local','c'),targets)
  state.companions[0].notificationDelivery={mode:'recent',targets:[]}
  assert.deepEqual(notificationRoutes(state,'a','alice'),[targets[1]])
  assert.deepEqual(notificationRoutes(state,'local','local','c'),[targets[1]])
  state.channels[1].enabled=false
  assert.throws(()=>notificationRoutes(state,'a','alice'),/不可用/)
  delete state.companions[0].notificationDelivery
  assert.deepEqual(notificationRoutes(state,'a','alice'),[targets[0]])
})

test('partial delivery survives restart, freezes recipients and skips acknowledged attachment/text parts',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'notification-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'state.json'),store=await PartnerStore.open(path)
  const sent=[];let fail=true
  const send=async(target,reply,part)=>{
    await part(0,async()=>sent.push(`${target.userId}:text:${reply.text}`))
    await part(1,async()=>{if(target.userId==='bob'&&fail)throw Error('offline');sent.push(`${target.userId}:file`)})
  }
  const payload={text:'original',attachments:[{path:'/tmp/example',name:'example',mediaType:'text/plain',kind:'file'}]}
  await assert.rejects(new NotificationDelivery(store).deliver('event','c',()=>targets,payload,send),/1 个/)
  assert.deepEqual(sent.sort(),['alice:file','alice:text:original','bob:text:original'])
  fail=false
  const restarted=await PartnerStore.open(path),delivery=new NotificationDelivery(restarted)
  await delivery.deliver('event','c',()=>{throw Error('must not resolve new targets')},{text:'changed',attachments:[]},send)
  assert.equal(sent.filter(s=>s==='bob:file').length,1)
  assert.equal(sent.length,4)
  await delivery.deliver('event','c',()=>targets,payload,()=>assert.fail('already delivered'))
  assert.equal(restarted.snapshot().notificationDeliveries[0].reply.text,'')
})

test('one blocked target does not block siblings and concurrent delivery is deduplicated',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'notification-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(dir,'state.json')),delivery=new NotificationDelivery(store)
  let calls=0
  const send=async(target,reply,part)=>{if(target.userId==='alice')throw Error('revoked');await part(0,async()=>{calls++})}
  const run=()=>delivery.deliver('event','c',()=>targets,{text:'hello',attachments:[]},send)
  await Promise.all([assert.rejects(run()),assert.rejects(run())])
  assert.equal(calls,1)
  await assert.rejects(run());assert.equal(calls,1)
})
