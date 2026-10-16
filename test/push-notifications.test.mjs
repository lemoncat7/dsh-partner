import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PartnerStore } from '../lib/store.js'
import { PushService } from '../lib/notifications/push-service.js'
import { barkAdapter, PushSendError } from '../lib/notifications/bark-adapter.js'
import { parsePushChannel } from '../lib/notifications/push-config.js'
import { pushEventsFromChanges, PushObserver } from '../lib/notifications/push-observer.js'
import { SplitStatePersistence } from '../lib/storage/split-state.js'
import { dispatchPushApi } from '../lib/api/features/push-api.js'
import { sendError } from '../lib/api/http.js'

const draft = (keys=['device-one','device-two']) => ({ platform:'bark', name:'测试渠道', baseUrl:'https://bark.example.test', targets:keys.map(key=>({name:key,key,enabled:true})) })
async function setup(t, send=async()=>{}) {
  const dir=await mkdtemp(join(tmpdir(),'partner-push-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const path=join(dir,'state.json'),store=await PartnerStore.open(path),secrets=new Map(),warnings=[]
  const vault={read:async id=>{if(!secrets.has(id))throw Error('missing');return secrets.get(id)},write:async(id,key)=>{secrets.set(id,key)},delete:async id=>{secrets.delete(id)}}
  const service=new PushService(store,vault,m=>warnings.push(m),{bark:{send}})
  t.after(()=>service.close())
  const owner=store.snapshot().companions[0].id
  return {dir,path,store,secrets,vault,service,owner,warnings}
}
const event=owner=>({id:'event-one',companionId:owner,title:'完成',text:'任务完成',createdAt:Date.now()+1,outcome:'completed'})
async function idle(store,predicate) { for(let i=0;i<200;i++){if(predicate(store.snapshot()))return;await new Promise(r=>setTimeout(r,5))}assert.fail('outbox did not settle') }

test('multiple servers/targets, masked edit, secret vault and private split-state roundtrip',async t=>{
  const {service,owner,store,secrets,path,dir}=await setup(t)
  const channel=await service.save(owner,draft())
  await service.save(owner,{...draft(['another-device']),baseUrl:'http://192.168.2.9:8080/prefix'})
  assert.equal(service.views().length,2);assert.equal(secrets.size,3)
  assert.ok(!JSON.stringify(channel).includes('credentialId'));assert.ok(!JSON.stringify(channel).includes('fingerprint'))
  assert.ok(!(await readFile(path,'utf8')).includes('"key"'))
  const saved=await service.save(owner,{...channel,targets:channel.targets.map(t=>({...t,key:''}))},channel.id)
  assert.equal(saved.revision,2);assert.equal(secrets.size,3)
  await assert.rejects(service.save(owner,channel,channel.id),/已更新/)
  const split=new SplitStatePersistence(join(dir,'public'),id=>join(dir,id))
  await split.write(store.snapshot());const restored=await PartnerStore.openSplit(split)
  assert.deepEqual(restored.snapshot().pushChannels,store.snapshot().pushChannels)
  const manifest=await readFile(join(dir,'public','state.json'),'utf8')
  assert.ok(!manifest.includes('bark.example.test'));assert.ok(!manifest.includes('credentialId'))
})

test('fanout independently retries failure without resending successful targets after restart',async t=>{
  const sent=[],{service,owner,store,path,vault}=await setup(t,async(_channel,key)=>{sent.push(key);if(key==='device-two')throw new PushSendError('network')})
  const channel=await service.save(owner,draft())
  const notice=event(owner);await service.enqueue(notice)
  await idle(store,s=>s.pushDeliveries?.some(r=>r.status==='accepted')&&s.pushDeliveries?.some(r=>r.lastError))
  assert.deepEqual(sent.sort(),['device-one','device-two'])
  await service.close()
  const restored=await PartnerStore.open(path)
  await restored.update(s=>{for(const r of s.pushDeliveries??[])if(r.status==='pending')r.nextAttemptAt=0})
  const restarted=new PushService(restored,vault,()=>{},{bark:{send:async(_c,key)=>{sent.push(key)}}});t.after(()=>restarted.close())
  await restarted.start();await idle(restored,s=>s.pushDeliveries.every(r=>r.status==='accepted'))
  await restarted.enqueue(notice);await restarted.flush()
  assert.equal(sent.filter(k=>k==='device-one').length,1);assert.equal(sent.filter(k=>k==='device-two').length,2)
  assert.equal(restarted.deliveries(channel.id).length,2)
})

test('edits cancel pending recipients, duplicate server targets dedupe, problems opt in',async t=>{
  const sent=[],{service,owner,store}=await setup(t,async(_c,key)=>{sent.push(key);throw new PushSendError('offline')})
  const channel=await service.save(owner,draft(['device-one']))
  await service.save(owner,draft(['device-one']))
  await service.enqueue({...event(owner),outcome:'problem'});assert.equal(store.snapshot().pushDeliveries?.length??0,0)
  await service.enqueue(event(owner));await idle(store,s=>s.pushDeliveries?.some(r=>r.lastError))
  assert.equal(sent.length,1)
  await service.save(owner,{...channel,enabled:false},channel.id)
  assert.equal(store.snapshot().pushDeliveries[0].status,'canceled')
  await assert.rejects(service.retry(channel.id,store.snapshot().pushDeliveries[0].id),/仅可重试/)
})

test('server acceptance errors are permanent and manual retry touches only failed rows',async t=>{
  let fail=true
  const {service,owner,store}=await setup(t,async()=>{if(fail)throw new PushSendError('Bark 服务返回 HTTP 400',false)})
  const channel=await service.save(owner,draft(['device-one']))
  await service.enqueue(event(owner));await idle(store,s=>s.pushDeliveries?.[0]?.status==='failed')
  fail=false;await service.retry(channel.id,store.snapshot().pushDeliveries[0].id)
  await idle(store,s=>s.pushDeliveries[0].status==='accepted')
  await assert.rejects(service.retry(channel.id,store.snapshot().pushDeliveries[0].id),/仅可重试/)
})

test('shutdown aborts a send, startup recovers sending state, owner deletion removes credentials',async t=>{
  const {service,owner,store,secrets}=await setup(t,async(_c,_key,_p,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new PushSendError('abort')),{once:true})))
  const channel=await service.save(owner,draft(['device-one']))
  await service.enqueue(event(owner));await idle(store,s=>s.pushDeliveries?.[0]?.status==='sending')
  await service.close();assert.equal(store.snapshot().pushDeliveries[0].status,'pending')
  await service.removeOwner(owner);assert.equal(secrets.size,0);assert.equal(service.views().length,0)
  assert.throws(()=>service.deliveries(channel.id),/不存在/)
})

test('configuration rejects duplicate keys, unsafe URLs, invalid IDs and accepts private servers',()=>{
  assert.throws(()=>parsePushChannel(draft(['same','same']),'c'),/重复/)
  assert.throws(()=>parsePushChannel({...draft(),baseUrl:'file:///etc/passwd'},'c'),/不支持/)
  assert.throws(()=>parsePushChannel({...draft(),baseUrl:'https://user:secret@example.test'},'c'),/不支持/)
  assert.throws(()=>parsePushChannel({...draft(),targets:[{id:'foreign',key:'a'}]},'c'),/已变化/)
  const {channel,secrets}=parsePushChannel({...draft(),baseUrl:'https://192.168.2.9:1443/bark/'},'c')
  assert.equal(channel.baseUrl,'https://192.168.2.9:1443/bark');assert.match(secrets[0].id,/^push-/)
})

test('Bark protocol uses POST JSON, preserves prefix and never follows redirects with device keys',async t=>{
  let received, mode='ok', redirected=0
  const server=createServer(async(req,res)=>{
    if(req.url==='/elsewhere'){redirected++;res.end('{}');return}
    const chunks=[];for await(const chunk of req)chunks.push(chunk)
    received={url:req.url,method:req.method,body:JSON.parse(Buffer.concat(chunks))}
    if(mode==='redirect'){res.writeHead(302,{location:'/elsewhere'});res.end();return}
    res.setHeader('content-type','application/json');res.end(mode==='invalid'?'not json':JSON.stringify({code:mode==='reject'?400:200,message:'secret must never be echoed'}))
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const channel=parsePushChannel({...draft(),baseUrl:`http://127.0.0.1:${server.address().port}/prefix`},'c').channel
  const send=()=>barkAdapter.send(channel,'sensitive-test-key',{title:'test',body:'body'},new AbortController().signal)
  await send();assert.equal(received.url,'/prefix/push');assert.equal(received.method,'POST');assert.equal(received.body.device_key,'sensitive-test-key')
  mode='reject';await assert.rejects(send(),e=>e instanceof PushSendError&&!e.retryable&&!e.message.includes('secret'))
  mode='invalid';await assert.rejects(send(),/不是 Bark JSON/)
  mode='redirect';await assert.rejects(send());assert.equal(redirected,0)
})

test('events ignore child tasks, bookkeeping, continuation checks and announce requirement once',async t=>{
  const {store,owner}=await setup(t),old=store.snapshot(),next=structuredClone(old)
  next.tasks=[{id:'child',status:'done',creatorCompanionId:owner}]
  assert.equal(pushEventsFromChanges(next,old).length,0)
  next.requirements=[{id:'r',ownerCompanionId:owner,title:'需求',status:'done',summary:'最终总结',updatedAt:Date.now()}]
  const events=pushEventsFromChanges(next,old);assert.equal(events.length,1)
  const newer=structuredClone(next);newer.requirements[0].revision=99;newer.requirements[0].notifiedAt=Date.now()
  assert.equal(pushEventsFromChanges(newer,next).length,0)
  next.schedules=[{id:'wake',companionId:owner,continuation:{state:'completed',finalReply:{key:'s:1',text:'final'}}}]
  assert.equal(pushEventsFromChanges(next,old).length,2)
  next.schedules[0].continuation.board={taskId:'child'}
  assert.equal(pushEventsFromChanges(next,old).length,1)
})

test('expired notifications require manual retry and retain their original date',async t=>{
  const {service,owner,store}=await setup(t,async()=>{throw new PushSendError('offline')})
  const channel=await service.save(owner,draft(['device-one']))
  await service.enqueue(event(owner));await idle(store,s=>s.pushDeliveries?.[0]?.lastError)
  await service.close()
  const date=Date.now()-2*86400_000
  await store.update(s=>{const r=s.pushDeliveries[0];r.createdAt=date;r.nextAttemptAt=0})
  const sent=[],restart=new PushService(store,{read:async()=> 'key'},()=>{},{bark:{send:async()=>sent.push(1)}})
  t.after(()=>restart.close());await restart.flush()
  assert.equal(store.snapshot().pushDeliveries[0].status,'failed');assert.equal(sent.length,0)
  await restart.retry(channel.id,store.snapshot().pushDeliveries[0].id)
  await idle(store,s=>s.pushDeliveries[0].status==='accepted')
  assert.equal(store.snapshot().pushDeliveries[0].createdAt,date)
  await restart.clearHistory(channel.id);assert.equal(restart.deliveries(channel.id).length,0)
})

test('startup recovers persisted in-flight delivery after process crash',async t=>{
  const {service,owner,store,path,vault}=await setup(t,async()=>{throw new PushSendError('offline')})
  await service.save(owner,draft(['device-one']));await service.enqueue(event(owner))
  await idle(store,s=>s.pushDeliveries?.[0]?.lastError);await service.close()
  await store.update(s=>{s.pushDeliveries[0].status='sending'})
  const restored=await PartnerStore.open(path),sent=[]
  const restart=new PushService(restored,vault,()=>{},{bark:{send:async()=>sent.push(1)}})
  t.after(()=>restart.close());await restart.start()
  await idle(restored,s=>s.pushDeliveries[0].status==='accepted');assert.equal(sent.length,1)
})

test('session notifications use final reply only, no pairing required, suppress internal review',async t=>{
  const {service,owner,store}=await setup(t),received=[]
  await service.save(owner,draft(['device-one']))
  await store.update(s=>s.sessions.push({id:'route',companionId:owner,sessionId:'session',channelId:'local',userId:'local'}))
  const observer=new PushObserver(store,{enqueue:async e=>received.push(e)},()=>assert.fail('enqueue failed'))
  const assistant=(seq,text,tool=false)=>({seq,type:'assistant/message',data:{message:{content:[{type:'text',text},...(tool?[{type:'tool-call'}]:[])]}}})
  const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{source:{kind:'user'}}},assistant(3,'正在检查',true),{seq:4,type:'tool/result'},assistant(5,'最终答案')]
  const session={id:'session',snapshotEvents:()=>events},end={seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}
  observer.observeSession(session,end)
  events[1]={seq:2,type:'user/message',data:{source:{kind:'plugin',pluginId:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴核验看板任务'}}}
  observer.observeSession(session,end)
  observer.observeSession(session,{...end,data:{...end.data,reason:{kind:'failed'}}})
  await observer.close();assert.equal(received.length,1);assert.equal(received[0].text,'最终答案')
})

test('push API guards mutations, returns masked config and supports test/delete',async t=>{
  const {service,owner}=await setup(t)
  const server=createServer(async(req,res)=>{try{await dispatchPushApi(req,res,req.url.slice(1).split('/'),service)}catch(e){sendError(res,e)}})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
  const base=`http://127.0.0.1:${server.address().port}/push-channels`,body=JSON.stringify({...draft(['device-one']),companionId:owner})
  assert.equal((await fetch(base,{method:'POST',body})).status,403)
  const headers={'x-dsh-partner-request':'1'},response=await fetch(base,{method:'POST',headers,body}),saved=await response.json()
  assert.equal(response.status,201);assert.ok(!JSON.stringify(saved).includes('credentialId'));assert.equal(saved.targets[0].key,undefined)
  assert.equal((await fetch(`${base}/${saved.id}/test`,{method:'POST',headers,body:JSON.stringify({targetId:saved.targets[0].id})})).status,200)
  assert.equal((await fetch(`${base}/${saved.id}`,{method:'DELETE',headers})).status,200)
  assert.equal(service.views().length,0)
})
