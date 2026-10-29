import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PartnerStore} from '../lib/store.js'
import {SleepService} from '../lib/character/sleep-service.js'
import {isSleeping,sleepPolicy,renderSleepContext} from '../lib/character/sleep.js'
import {idleContactDue,DEFAULT_IDLE_CONTACT} from '../lib/character/idle-contact.js'
import {applyIdentity,pageIdentity} from '../lib/companions/identity.js'

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'partner-sleep-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'state.json'),store=await PartnerStore.open(path),id=store.snapshot().companions[0].id
 await store.update(s=>{const c=s.companions[0];c.sleepPolicy={enabled:true,dreamsEnabled:true};c.automation.memory.enabled=true;c.idleContact={...DEFAULT_IDLE_CONTACT,enabled:true,routeId:'r'};s.sessions=[{id:'r',kind:'local',channelId:'@local',userId:'owner',companionId:id,sessionId:'s',lastMessageAt:Date.now()-3*3600000},{id:'foreign',kind:'local',channelId:'@local',userId:'other',companionId:'other',sessionId:'other-session',lastMessageAt:1}]})
 const calls=[],memoryCalls=[],memories=[{id:'m1',status:'active',subject:'喜好',content:'喜欢安静的雨天'}]
 let result={sleep:true,minutes:60,reason:'想静静回味刚才的事',dream:true},busy=false,streamOverride
 const ctx={logger:{warn(){}},get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{stream(input){calls.push(input);return streamOverride?streamOverride(input):(async function*(){yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'finish',reason:{kind:'stop'}}})()}}}
 const memory={recentMemories:async(...args)=>{memoryCalls.push(args);return memories}}
 const ports={busy:()=>busy,archived:()=>false}
 const service=new SleepService(ctx,store,memory,ports);t.after(()=>service.close())
 const c=()=>store.snapshot().companions[0]
 return {store,id,path,c,service,calls,memoryCalls,memories,ctx,memory,ports,setResult:v=>result=v,setBusy:v=>busy=v,setStream:f=>streamOverride=f}
}

test('character-only defaults; autonomous decision can stay awake or sleep at any clock time',async t=>{
 assert.equal(sleepPolicy({}).enabled,false);assert.equal(sleepPolicy({characterCard:{enabled:true}}).enabled,true)
 const f=await fixture(t)
 f.setResult({sleep:false,minutes:60,reason:'还不想睡',dream:false})
 await f.service.tick();assert.equal(isSleeping(f.c()),false);assert.equal(f.calls.length,1)
 await f.service.tick();assert.equal(f.calls.length,1,'same inactivity does not repeatedly call model')
 await f.store.update(s=>{s.companions[0].sleepState.decision.at-=3600001;s.sessions[0].lastMessageAt+=1000})
 f.setResult({sleep:true,minutes:45,reason:'想休息',dream:true})
 await f.service.tick();assert.equal(isSleeping(f.c()),true)
 const e=f.c().sleepState.episode;assert.equal(e.wakeAt-e.startedAt,45*60000)
})
test('dream reads only current conversation memory, writes a separate fictional record, and survives restart',async t=>{
 const f=await fixture(t)
 await f.service.sleep(f.id,'r',30,'想睡一会儿')
 f.setResult({narrative:'梦见雨滴变成了小灯。',feeling:'有点安心。',topic:'想聊雨天喜欢做的事'})
 await f.service.tick()
 const state=f.c().sleepState
 assert.equal(state.episode.dream,'completed');assert.equal(state.dreams.length,1)
 assert.deepEqual(f.memoryCalls[0],[f.id,12,'@local:owner'])
 assert.deepEqual(state.dreams[0].sourceMemoryIds,['m1'])
 assert.match(renderSleepContext(f.c(),'r'),/非事实记忆/)
 assert.equal(renderSleepContext(f.c(),'foreign'),'')
 assert.equal(f.c().identityDraft,undefined,'sleep changes never alter identity draft')
 assert.equal(f.c().automation.memory.dailyReviewEnabled,false)
 assert.equal((await PartnerStore.open(f.path)).snapshot().companions[0].sleepState.dreams.length,1)
 await f.service.tick();assert.equal(f.calls.length,1,'dream is not regenerated')
})
test('new user message wakes immediately and discards an in-flight dream',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',60,'休息')
 let started;const generating=new Promise(r=>started=r)
 f.setStream(input=>(async function*(){started();await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));yield {type:'text-delta',text:'{"narrative":"stale","feeling":"","topic":""}'};yield {type:'finish',reason:{kind:'stop'}}})())
 const tick=f.service.tick();await generating
 await f.service.onUserMessage('s',Date.now()+1);await tick
 assert.equal(isSleeping(f.c()),false);assert.equal(f.c().sleepState.episode.dream,'skipped');assert.equal(f.c().sleepState.dreams,undefined)
})
test('wake on schedule, restart does not replay failed/incomplete dream; work prevents new sleep',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',5,'小睡')
 await f.store.update(s=>{s.companions[0].sleepState.episode.dream='generating'})
 await f.service.tick();assert.equal(f.c().sleepState.episode.dream,'failed');assert.equal(f.calls.length,0)
 await f.store.update(s=>{s.companions[0].sleepState.episode.wakeAt=Date.now()-1;s.companions[0].sleepState.decision={activityAt:s.sessions[0].lastMessageAt,at:Date.now(),outcome:'sleep'}})
 await f.service.tick();assert.equal(isSleeping(f.c()),false);assert.equal(f.c().sleepState.episode.wakeReason,'自然醒来')
 await f.store.update(s=>{s.executionRuns.push({id:'job',ownerCompanionId:f.id,status:'queued'})})
 await assert.rejects(f.service.sleep(f.id,'r',10,'休息'),/任务/)
})
test('memory disabled or no memory means no dream; it never enables memory or clears context',async t=>{
 const f=await fixture(t);await f.store.update(s=>{s.companions[0].automation.memory.enabled=false})
 await f.service.sleep(f.id,'r',20,'休息');await f.service.tick()
 assert.equal(f.c().sleepState.episode.dream,'skipped');assert.equal(f.memoryCalls.length,0);assert.equal(f.calls.length,0)
 await f.service.wake(f.id);await f.store.update(s=>{s.companions[0].automation.memory.enabled=true});f.memories.length=0
 await f.service.sleep(f.id,'r',20,'休息');await f.service.tick();assert.equal(f.c().sleepState.episode.dream,'skipped');assert.equal(f.calls.length,0)
})
test('sleep suppresses idle greetings but waking restores normal checks; no fixed quiet-hour restrictions',async t=>{
 const f=await fixture(t),user={id:'u',at:Date.now()-4*3600000}
 await f.service.sleep(f.id,'r',60,'休息',false)
 assert.equal(idleContactDue(f.store.snapshot(),f.c(),user,Date.now(),'Asia/Shanghai'),false)
 await f.service.wake(f.id)
 assert.equal(idleContactDue(f.store.snapshot(),f.c(),user,Date.now(),'Asia/Shanghai'),true)
})
test('tools cannot cross owners or expose another conversation dream, and do not change permissions',async t=>{
 const f=await fixture(t),tool=f.service.tool(f.id),signal=new AbortController().signal,exec={signal,agent:{session:{id:'s'}}}
 await assert.rejects(tool.execute({action:'sleep',minutes:30,reason:'睡觉'},{...exec,agent:{session:{id:'other-session'}}}),/自己的/)
 await f.store.update(s=>{s.companions[0].sleepState={dreams:[{id:'private',routeId:'other',narrative:'hidden'}]}})
 assert.deepEqual(JSON.parse(await tool.execute({action:'inspect'},exec)).dreams,[])
 await tool.execute({action:'sleep',minutes:30,reason:'小睡',dream:false},exec)
 assert.equal(isSleeping(f.c()),true);assert.deepEqual(f.c().capabilities,[])
 await tool.execute({action:'wake'},exec);assert.equal(isSleeping(f.c()),false)
})
test('configuration changes preserve sleep history and draft separation; disabling sleep permits immediate contact',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',30,'休息')
 const previous=f.c(),draft=pageIdentity(previous)
 await f.store.update(s=>applyIdentity(s,s.companions[0],{sleepPolicy:{enabled:false}},previous.updatedAt,'ai'))
 assert.equal(isSleeping(f.c()),false);assert.deepEqual(f.c().identityDraft,draft);assert.equal(f.c().sleepState.episode.id,previous.sleepState.episode.id)
 await f.service.tick();assert.equal(f.c().sleepState.episode.wakeReason,'睡眠功能已关闭')
})
test('new activity or task arriving during autonomous decision invalidates sleep; output truncation cannot apply',async t=>{
 const f=await fixture(t)
 f.setStream(input=>(async function*(){await f.service.onUserMessage('s',Date.now());yield {type:'text-delta',text:'{"sleep":true,"minutes":60,"reason":"sleep"}'};yield {type:'finish',reason:{kind:'stop'}}})())
 await f.service.tick();assert.equal(isSleeping(f.c()),false)
 await f.store.update(s=>{s.companions[0].sleepState={};s.sessions[0].lastMessageAt=Date.now()-4*3600000})
 f.setStream(()=>(async function*(){yield {type:'text-delta',text:'{"sleep":true,"minutes":60,"reason":"sleep"}'}})())
 await f.service.tick();assert.equal(isSleeping(f.c()),false)
 await f.service.tick();assert.equal(f.calls.length,2,'failed request is not retried every minute')
})

test('manual wake invalidates a pending sleep decision even before an episode exists',async t=>{
 const f=await fixture(t)
 f.setStream(()=>(async function*(){await f.service.wake(f.id,'用户唤醒');yield {type:'text-delta',text:'{"sleep":true,"minutes":60,"reason":"想休息"}'};yield {type:'finish',reason:{kind:'stop'}}})())
 await f.service.tick();assert.equal(isSleeping(f.c()),false);assert.equal(f.c().sleepState.episode,undefined)
})
test('changing persona while dreaming discards the outdated result; shared session routes can inspect their own dream',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',30,'休息')
 f.setStream(()=>(async function*(){await f.store.update(s=>{s.companions[0].updatedAt++});yield {type:'text-delta',text:'{"narrative":"旧人格梦境","feeling":"","topic":""}'};yield {type:'finish',reason:{kind:'stop'}}})())
 await f.service.tick();assert.equal(f.c().sleepState.dreams,undefined);assert.equal(f.c().sleepState.episode.dream,'skipped')
 await f.store.update(s=>{s.sessions.push({...s.sessions[0],id:'alias',kind:'channel'});s.companions[0].sleepState.dreams=[{id:'d',routeId:'alias',at:Date.now(),narrative:'shared',feeling:'',topic:'',sourceMemoryIds:[]}]})
 const result=JSON.parse(await f.service.tool(f.id).execute({action:'inspect'},{signal:new AbortController().signal,agent:{session:{id:'s'}}}))
 assert.equal(result.dreams[0].narrative,'shared')
})

test('partial dream setting edit preserves the implicit off state of work-only identities',async t=>{
 const f=await fixture(t)
 await f.store.update(s=>{delete s.companions[0].sleepPolicy;delete s.companions[0].characterCard})
 const before=f.c()
 await f.store.update(s=>applyIdentity(s,s.companions[0],{sleepPolicy:{dreamsEnabled:false}},before.updatedAt,'ai'))
 assert.deepEqual(f.c().sleepPolicy,{enabled:false,dreamsEnabled:false})
})
