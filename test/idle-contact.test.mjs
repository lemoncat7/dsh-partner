import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DEFAULT_IDLE_CONTACT,IDLE_CONTACT_NOTICE,normalizeIdleContact,idleContactDue,idleContactDay,idleContactQuiet,lastIdleContactUser} from '../lib/character/idle-contact.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {PartnerStore} from '../lib/store.js'
import {HeartbeatScheduler} from '../lib/heartbeat.js'

const now=Date.parse('2026-10-28T06:00:00Z'),tz='Asia/Shanghai'
const user={id:'user-1',at:now-3*3600_000}
function fixture(){
  const companion={id:'c',updatedAt:1,idleContact:{...DEFAULT_IDLE_CONTACT,enabled:true,routeId:'r'},automation:{heartbeat:{enabled:false}}}
  const route={id:'r',kind:'channel',channelId:'ch',userId:'peer',companionId:'c',sessionId:'s',lastMessageAt:user.at}
  const state={companions:[companion],sessions:[route],channels:[{id:'ch',companionId:'c',enabled:true}],pairings:[{channelId:'ch',userId:'peer',status:'approved'}],heartbeatStates:[],recentReceipts:[]}
  return {companion,route,state}
}
test('defaults opt out, strict input and legacy quiet hours no longer apply',()=>{
  assert.equal(DEFAULT_IDLE_CONTACT.enabled,false)
  for(const bad of [{...DEFAULT_IDLE_CONTACT,enabled:true},{...DEFAULT_IDLE_CONTACT,idleMinutes:0}])assert.throws(()=>normalizeIdleContact(bad))
  assert.equal(idleContactQuiet(DEFAULT_IDLE_CONTACT,Date.parse('2026-10-28T16:00:00Z'),tz),false)
  assert.equal(idleContactQuiet(DEFAULT_IDLE_CONTACT,Date.parse('2026-10-28T01:00:00Z'),tz),false)
  assert.equal(idleContactQuiet({...DEFAULT_IDLE_CONTACT,quietStartHour:9,quietEndHour:17},now,tz),false)
  assert.equal(idleContactQuiet({...DEFAULT_IDLE_CONTACT,quietStartHour:9,quietEndHour:9},now,tz),false)
})
test('only real user inactivity qualifies; deny recent activity, unauthorized targets and foreign owners',()=>{
  const {state,companion,route}=fixture()
  assert.equal(idleContactDue(state,companion,user,now,tz),true)
  assert.equal(idleContactDue(state,companion,undefined,now,tz),false)
  route.lastMessageAt=now;assert.equal(idleContactDue(state,companion,user,now,tz),false);route.lastMessageAt=user.at
  state.pairings[0].status='blocked';assert.equal(idleContactDue(state,companion,user,now,tz),false);state.pairings[0].status='approved'
  state.channels[0].companionId='other';assert.equal(idleContactDue(state,companion,user,now,tz),false)
  assert.deepEqual(lastIdleContactUser([{type:'user/message',time:123,data:{id:'real',source:{kind:'user'}}},{type:'user/message',time:456,data:{id:'internal',source:{kind:'plugin:task'}}}]),{id:'real',at:123})
})
test('no reply means no repeat even next day; no daily cap and cooldown span routes',()=>{
  const {state,companion,route}=fixture()
  route.idleContactState={userMessageId:user.id,attemptedAt:now-3*3600_000,day:idleContactDay(now,tz),count:1}
  assert.equal(idleContactDue(state,companion,user,now+86400_000,tz),false)
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),true)
  state.sessions.push({...route,id:'r2',idleContactState:{...route.idleContactState,count:999}})
  companion.idleContact.dailyLimit=1 // Legacy stored limits no longer restrict sending.
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),true)
  state.sessions.pop();route.idleContactState.attemptedAt=now-60_000
  assert.equal(idleContactDue(state,companion,{...user,id:'new'},now,tz),false)
})
function runtimeFixture(){
  const {state,companion,route}=fixture();companion.idleContact.quietStartHour=0;companion.idleContact.quietEndHour=0
  const events=[{type:'user/message',seq:1,time:Date.now()-4*3600_000,data:{id:user.id,source:{kind:'user'}}}]
  const followed=[]
  const agent={status:'idle',session:{seq:1,snapshotEvents:()=>events},followup:m=>followed.push(m)}
  const store={subscribe:()=>()=>{},snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)}
  const runtime=new PartnerAgentRuntime({agents:{get:()=>undefined}},store,'/tmp')
  runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
  return {runtime,store,agent,events,followed,state,companion,route}
}
test('claims before followup; concurrent checks and restart cannot repeat an uncertain attempt',async()=>{
  const f=runtimeFixture()
  await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')])
  assert.equal(f.followed.length,1);assert.equal(f.followed[0].source.summary,IDLE_CONTACT_NOTICE)
  assert.notEqual(f.followed[0].source.kind,'user')
  assert.equal(f.route.idleContactState.messageId,f.followed[0].id)
  const restarted=new PartnerAgentRuntime({agents:{get:()=>undefined}},f.store,'/tmp');restarted.ensureAgent=async()=>f.agent;restarted.isArchived=()=>false
  await restarted.idleContact('c');assert.equal(f.followed.length,1)
})
test('busy conversation and input arriving during durable claim do not start a greeting',async()=>{
  const f=runtimeFixture();f.agent.status='running';await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
  f.agent.status='idle';f.store.update=async fn=>{fn(f.state);f.agent.session.seq++}
  await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
})
test('claim survives disk reopening',async t=>{
  const root=await mkdtemp(join(tmpdir(),'partner-idle-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const store=await PartnerStore.open(join(root,'state.json')),f=fixture()
  await store.update(s=>{s.sessions=[{...f.route,idleContactState:{userMessageId:'u',messageId:'m',attemptedAt:now,day:idleContactDay(now,tz),count:1,timeZone:tz,policyRevision:1}}]})
  const reopened=await PartnerStore.open(join(root,'state.json'))
  assert.equal(reopened.snapshot().sessions[0].idleContactState.messageId,'m')
})
test('existing heartbeat timer checks idle contact even when concerns heartbeat is disabled',async()=>{
  const f=fixture();let calls=0
  const scheduler=new HeartbeatScheduler({logger:{warn:()=>{}}},{snapshot:()=>f.state},{idleContact:async()=>calls++},{},{})
  await scheduler.tick();await new Promise(r=>setImmediate(r));assert.equal(calls,1);await scheduler.close()
})
function deliveryFixture(){
  const f=fixture(),messageId='idle-1';f.companion.idleContact.quietStartHour=0;f.companion.idleContact.quietEndHour=0
  f.route.idleContactState={userMessageId:user.id,messageId,attemptedAt:now,day:idleContactDay(now,tz),count:1,timeZone:tz,policyRevision:1}
  const events=[{type:'user/message',seq:0,time:user.at,data:{id:user.id,source:{kind:'user'}}},{type:'turn/start',seq:1,data:{turn:1}},{type:'user/message',seq:2,data:{id:messageId,source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}},{type:'assistant/message',seq:3,data:{message:{content:[{type:'text',text:'刚想起你说的那个事。'}]}}},{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}]
  const manager=new ChannelManager({}, {snapshot:()=>f.state,isCompanionRemoving:()=>false}, {},{isArchived:()=>false},'/tmp'), sent=[]
  manager.queueProactive=async(route,receipt,reply,valid,exact)=>{if(valid())sent.push({route,receipt,reply,exact})}
  return {...f,events,manager,sent,session:{id:'s',snapshotEvents:()=>events},end:events.at(-1)}
}
test('native completed reply delivers once to explicit origin, not notification broadcasts',async()=>{
  const f=deliveryFixture();await f.manager.observeAutonomousResult(f.session,f.end)
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].exact,true);assert.equal(f.sent[0].route.id,'r');assert.equal(f.sent[0].receipt,'idle:idle-1');assert.match(f.sent[0].reply.text,/刚想起/)
})
for(const scenario of ['disabled','revoked','new input','changed setting','local'])test(`idle delivery is suppressed for ${scenario}`,async()=>{
  const f=deliveryFixture()
  if(scenario==='disabled')f.companion.idleContact.enabled=false
  if(scenario==='revoked')f.state.pairings[0].status='blocked'
  if(scenario==='changed setting')f.companion.updatedAt++
  if(scenario==='local')f.route.kind='local'
  if(scenario==='new input')f.events.push({type:'user/message',seq:5,time:now,data:{id:'new',source:{kind:'user'}}})
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
})

test('idle contact never starves concern continuations when both features are enabled',async()=>{
  const f=fixture();f.companion.automation.heartbeat.enabled=true
  f.state.heartbeatStates=[{companionId:'c',nextCheckAt:Date.now()+3600_000}]
  const calls=[]
  const scheduler=new HeartbeatScheduler({logger:{warn:()=>{}}},{snapshot:()=>f.state},{idleContact:async()=>calls.push('idle')},{},{pendingRecording:async()=>undefined})
  scheduler.setExecutionDispatcher(async()=>calls.push('work'))
  await scheduler.tick();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['work','idle']);await scheduler.close()
})


test('legacy quiet hours are discarded; sleep controls actual channel delivery without daily caps',async()=>{
  assert.equal(normalizeIdleContact({...DEFAULT_IDLE_CONTACT,quietEnabled:true,quietStartHour:23,quietEndHour:9}).quietEnabled,undefined)
  const f=deliveryFixture()
  f.companion.sleepPolicy={enabled:true,dreamsEnabled:true}
  f.companion.sleepState={episode:{id:'sleep',startedAt:Date.now(),wakeAt:Date.now()+60000,routeId:'r',dream:'skipped'}}
  f.route.idleContactState.count=999
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,0)
  f.companion.sleepState.episode.wokeAt=Date.now()
  await f.manager.observeAutonomousResult(f.session,f.end);assert.equal(f.sent.length,1)
})
