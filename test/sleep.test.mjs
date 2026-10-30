import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {PartnerStore} from '../lib/store.js'
import {SleepService} from '../lib/character/sleep-service.js'
import {isSleeping,sleepPolicy,renderSleepContext,sleepActivity} from '../lib/character/sleep.js'
import {fatigueValue,settleFatigue,fatigueSleepProbability,wakeCallsNeeded} from '../lib/character/fatigue.js'
import {idleContactDue,DEFAULT_IDLE_CONTACT} from '../lib/character/idle-contact.js'
import {applyIdentity,pageIdentity} from '../lib/companions/identity.js'
const MIN=60_000,HOUR=60*MIN
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'partner-sleep-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const path=join(root,'state.json'),store=await PartnerStore.open(path),id=store.snapshot().companions[0].id
 let now=Date.now(),random=.9,busy=false,streamOverride
 await store.update(s=>{const c=s.companions[0];c.sleepPolicy={enabled:true,dreamsEnabled:true};c.sleepState={fatigue:{value:80,at:now},activityAt:now-3*HOUR};c.automation.memory.enabled=true;c.idleContact={...DEFAULT_IDLE_CONTACT,enabled:true,routeId:'r'};s.sessions=[{id:'r',kind:'local',channelId:'@local',userId:'owner',companionId:id,sessionId:'s',lastMessageAt:now-3*HOUR},{id:'foreign',kind:'local',channelId:'@local',userId:'other',companionId:'other',sessionId:'other-session',lastMessageAt:1}]})
 const calls=[],memoryCalls=[],memories=[{id:'m1',status:'active',subject:'喜好',content:'喜欢安静的雨天'}]
 let result={narrative:'梦见雨滴变成了小灯。',feeling:'有点安心。',topic:'雨天'}
 const ctx={logger:{warn(){}},get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{stream(input){calls.push(input);return streamOverride?streamOverride(input):(async function*(){yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'finish',reason:{kind:'stop'}}})()}}}
 const memory={recentMemories:async(...args)=>{memoryCalls.push(args);return memories}}
 const ports={busy:()=>busy,archived:()=>false,now:()=>now,random:()=>random}
 const service=new SleepService(ctx,store,memory,ports);t.after(()=>service.close())
 const c=()=>store.snapshot().companions[0]
 return {store,id,path,c,service,calls,memoryCalls,memories,ctx,memory,ports,now:()=>now,advance:ms=>now+=ms,due:()=>{now=c().sleepState.episode.nextDreamAt},sleeping:()=>isSleeping(c(),now),setRandom:v=>random=v,setResult:v=>result=v,setBusy:v=>busy=v,setStream:f=>streamOverride=f,seed:async value=>store.update(s=>{s.companions[0].sleepState.fatigue={value,at:now}})}
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<.001,`${a} ≈ ${b}`)

test('fatigue integrates awake time, partial sleep and offline natural wake without instant reset',async t=>{
 const f=await fixture(t);await f.seed(30);f.advance(HOUR);near(fatigueValue(f.c(),f.now()),35)
 await f.service.sleep(f.id,'r',60,'小睡',false);f.advance(10*MIN);near(fatigueValue(f.c(),f.now()),32.5)
 await f.service.wake(f.id);near(fatigueValue(f.c(),f.now()),32.5)
 f.advance(HOUR);near(fatigueValue(f.c(),f.now()),37.5)
 await f.service.sleep(f.id,'r',60,'再睡',false);f.advance(2*HOUR);near(fatigueValue(f.c(),f.now()),27.5)
 await f.service.tick();assert.equal(f.sleeping(),false);near(fatigueValue(f.c(),f.now()),27.5)
 assert.equal(f.c().sleepState.episode.wakeReason,'自然醒来')
 const reopened=(await PartnerStore.open(f.path)).snapshot().companions[0];near(fatigueValue(reopened,f.now()),27.5)
})
test('fatigue caps, elapsed minutes do not lose time, disabled freezes and clock rollback does not increase rest',()=>{
 const c={sleepPolicy:{enabled:true,dreamsEnabled:false},sleepState:{fatigue:{value:30,at:HOUR}}}
 for(let i=1;i<=60;i++)settleFatigue(c,HOUR+i*MIN)
 near(fatigueValue(c,2*HOUR),35)
 assert.equal(fatigueValue(c,100*HOUR),100)
 assert.equal(fatigueValue(c,HOUR),c.sleepState.fatigue.value)
 c.sleepState={fatigue:{value:5,at:HOUR},episode:{startedAt:HOUR,wakeAt:2*HOUR}}
 assert.equal(fatigueValue(c,2*HOUR),0);assert.equal(fatigueValue(c,3*HOUR),5)
 c.sleepPolicy.enabled=false;assert.equal(fatigueValue(c,100*HOUR),5)
})
test('local fatigue rolls retry unchanged inactivity each minute; no model sleep gate or duplicate concurrent rolls',async t=>{
 assert.equal(sleepPolicy({}).enabled,false);assert.equal(sleepPolicy({characterCard:{enabled:true}}).enabled,true)
 assert.equal(fatigueSleepProbability(39),0)
 assert.ok(fatigueSleepProbability(90)>fatigueSleepProbability(60))
 const f=await fixture(t);await f.service.tick();assert.equal(f.sleeping(),false)
 const decision=f.c().sleepState.decision
 f.setRandom(0);await Promise.all([f.service.tick(),f.service.tick()]);assert.deepEqual(f.c().sleepState.decision,decision)
 f.advance(MIN);await Promise.all([f.service.tick(),f.service.tick()]);assert.equal(f.sleeping(),true)
 assert.equal(f.calls.length,0,'falling asleep does not require an LLM')
 assert.equal(f.c().sleepState.episode.segments,0)
})
test('work and foreground busy block sleep; human activity invalidates an admission and autonomous route timestamps do not postpone it',async t=>{
 const f=await fixture(t);f.setRandom(0);f.setBusy(true);await f.service.tick();assert.equal(f.sleeping(),false)
 f.setBusy(false);await f.store.update(s=>s.executionRuns.push({id:'job',ownerCompanionId:f.id,status:'queued'}));await f.service.tick();assert.equal(f.sleeping(),false)
 await assert.rejects(f.service.sleep(f.id,'r',20,'睡'),/任务/)
 await f.store.update(s=>{s.executionRuns=[]})
 const old=sleepActivity(f.store.snapshot(),f.c());await f.service.onUserMessage('s',f.now(),'new')
 await assert.rejects(f.service.sleep(f.id,'r',20,'睡',false,old),/新活动/)
 f.advance(4*MIN);const activity=f.c().sleepState.activityAt
 await f.store.update(s=>{s.sessions[0].lastMessageAt=f.now()})
 assert.equal(sleepActivity(f.store.snapshot(),f.c()),activity)
 await f.service.tick();assert.equal(f.sleeping(),true)
})
test('private calls wake gradually, deduplicate retries and bursts, and preserve remaining fatigue',async t=>{
 const f=await fixture(t);await f.seed(90);await f.service.sleep(f.id,'r',120,'休息',false)
 f.advance(10*MIN);await f.service.onUserMessage('s',f.now(),'a');assert.equal(f.sleeping(),true)
 assert.equal(f.c().sleepState.reception.calls,1);assert.equal(f.c().sleepState.reception.needed,4)
 await f.service.onUserMessage('s',f.now(),'a');await f.service.onUserMessage('s',f.now(),'burst');assert.equal(f.c().sleepState.reception.calls,1)
 for(const id of ['b','c','d']){f.advance(11_000);await f.service.onUserMessage('s',f.now(),id)}
 assert.equal(f.sleeping(),false);assert.ok(fatigueValue(f.c(),f.now())>87)
 assert.match(renderSleepContext(f.c(),'r','d',f.now()),/本轮刚被叫醒/)
 assert.doesNotMatch(renderSleepContext(f.c(),'r','unrelated',f.now()),/本轮刚被叫醒/)
})
test('wake pressure expires; group messages and autonomous notices do not count as private wake calls; urgency wakes',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',120,'睡',false)
 await f.service.onUserMessage('s',f.now(),'group',false);assert.equal(f.c().sleepState.reception,undefined)
 const notice=createUserMessage({content:[{type:'text',text:'紧急'}],source:{kind:'plugin:test',form:'notice',summary:'activity'}})
 await f.service.acceptInput('s',[notice]);assert.equal(f.sleeping(),true)
 await f.service.onUserMessage('s',f.now(),'call1');f.advance(11*MIN);await f.service.onUserMessage('s',f.now(),'call2');assert.equal(f.c().sleepState.reception.calls,1)
 const urgent=createUserMessage({content:[{type:'text',text:'立即醒来，有急事'}],source:{kind:'user'}})
 await f.service.acceptInput('s',[urgent]);assert.equal(f.sleeping(),false);assert.ok(fatigueValue(f.c(),f.now())>70)
 assert.deepEqual([20,30,60,90].map(wakeCallsNeeded),[1,2,3,4])
})
test('sleeping private prompt is scoped to admitted message and persona; alias group routes never count as private',async t=>{
 const f=await fixture(t);await f.seed(60);await f.service.sleep(f.id,'r',120,'睡',false)
 const user=createUserMessage({content:[{type:'text',text:'在吗'}],source:{kind:'user'}})
 await f.service.acceptInput('s',[user]);const prompt=renderSleepContext(f.c(),'r',user.id,f.now())
 assert.match(prompt,/仍未清醒/);assert.match(prompt,/当前人格/);assert.match(prompt,/不固定复读/)
 assert.doesNotMatch(renderSleepContext(f.c(),'r',undefined,f.now()),/本轮是睡眠中的私聊/)
 const group=createUserMessage({content:[{type:'text',text:'醒醒'}],source:{kind:'user'}})
 await f.store.update(s=>s.sessions.push({...s.sessions[0],id:'group',kind:'channel',userId:'group:123:456',inboundMessageIds:[group.id]}))
 await f.service.acceptInput('s',[group]);assert.equal(f.c().sleepState.reception.calls,1)
})
test('dream can be absent, starts later, reads only scoped memories and remains separate across restart',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',60,'无梦',false);f.advance(20*MIN);await f.service.tick();assert.equal(f.calls.length,0)
 await f.service.wake(f.id);await f.service.sleep(f.id,'r',60,'睡')
 await f.service.tick();assert.equal(f.calls.length,0,'no immediate dream')
 f.due();await f.service.tick();const state=f.c().sleepState
 assert.equal(state.episode.dream,'completed');assert.equal(state.dreams.length,1)
 assert.deepEqual(f.memoryCalls[0],[f.id,12,'@local:owner']);assert.deepEqual(state.dreams[0].sourceMemoryIds,['m1'])
 assert.match(renderSleepContext(f.c(),'r',undefined,f.now()),/非事实记忆/)
 assert.doesNotMatch(renderSleepContext(f.c(),'foreign',undefined,f.now()),/雨滴/)
 assert.equal(f.c().automation.memory.dailyReviewEnabled,false)
 assert.equal((await PartnerStore.open(f.path)).snapshot().companions[0].sleepState.dreams.length,1)
 await f.service.tick();assert.equal(f.calls.length,1)
})
test('completed dream segments persist while an interrupted segment is discarded, and dreaming may resume',async t=>{
 const f=await fixture(t);f.setRandom(0);await f.service.sleep(f.id,'r',180,'做梦');f.due();await f.service.tick()
 assert.equal(f.c().sleepState.dreams.length,1)
 let started;const generating=new Promise(r=>started=r)
 f.setStream(input=>(async function*(){started();await new Promise(resolve=>input.signal.addEventListener('abort',resolve,{once:true}));yield {type:'text-delta',text:'{"narrative":"unfinished","feeling":"","topic":""}'};yield {type:'finish',reason:{kind:'stop'}}})())
 f.due();const tick=f.service.tick();await generating;const duplicate=f.service.tick()
 await f.service.onUserMessage('s',f.now(),'interrupt');await Promise.all([tick,duplicate])
 assert.equal(f.sleeping(),true);assert.equal(f.c().sleepState.episode.dream,'interrupted');assert.equal(f.c().sleepState.dreams.length,1)
 assert.equal(f.calls.length,2);assert.ok(f.c().sleepState.episode.nextDreamAt>f.now())
 f.setStream(undefined);f.setResult({narrative:'梦里的小灯漂远了。',feeling:'安静',topic:''});f.due();await f.service.tick()
 assert.deepEqual(f.c().sleepState.dreams.map(d=>d.segment),[1,2]);assert.doesNotMatch(JSON.stringify(f.c().sleepState.dreams),/unfinished/)
 const input=JSON.parse(f.calls[2].messages[0].content[0].text).input;assert.equal(input.completedSegments.length,1)
 for(let i=0;i<2;i++){f.due();await f.service.tick()}
 assert.equal(f.c().sleepState.dreams.length,4);assert.equal(f.c().sleepState.episode.nextDreamAt,undefined)
})
test('wake during memory read cancels dream before generation, and manual wake does not zero fatigue',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',60,'睡');f.due()
 f.memory.recentMemories=async()=>{await f.service.wake(f.id);return f.memories}
 await f.service.tick();assert.equal(f.calls.length,0);assert.equal(f.sleeping(),false);assert.ok(fatigueValue(f.c(),f.now())>70)
})
test('shutdown/restart treats abandoned dream as interrupted and defers continuation',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',60,'睡');await f.store.update(s=>{s.companions[0].sleepState.episode.dream='generating'})
 await f.service.tick();assert.equal(f.c().sleepState.episode.dream,'interrupted');assert.equal(f.calls.length,0)
 assert.ok(f.c().sleepState.episode.nextDreamAt>f.now());f.due();await f.service.tick();assert.equal(f.c().sleepState.dreams.length,1)
})
test('truncated output, missing finish and persona change cannot save a dream',async t=>{
 for(const kind of ['partial','length','persona']){
  const f=await fixture(t);await f.service.sleep(f.id,'r',60,'睡');f.due()
  f.setStream(()=>(async function*(){if(kind==='persona')await f.store.update(s=>{s.companions[0].updatedAt++});yield {type:'text-delta',text:'{"narrative":"stale","feeling":"","topic":""}'};if(kind!=='partial')yield {type:'finish',reason:{kind:kind==='length'?'length':'stop'}}})())
  await f.service.tick();assert.equal(f.c().sleepState.dreams,undefined)
  assert.equal(f.c().sleepState.episode.dream,kind==='persona'?'skipped':'failed')
 }
})
test('memory disabled or absent skips dreams without enabling memory or clearing context',async t=>{
 const f=await fixture(t);await f.store.update(s=>{s.companions[0].automation.memory.enabled=false})
 await f.service.sleep(f.id,'r',60,'休息');f.advance(20*MIN);await f.service.tick();assert.equal(f.c().sleepState.episode.dream,'skipped');assert.equal(f.memoryCalls.length,0)
 await f.service.wake(f.id);await f.store.update(s=>{s.companions[0].automation.memory.enabled=true});f.memories.length=0
 await f.service.sleep(f.id,'r',60,'休息');f.due();await f.service.tick();assert.equal(f.c().sleepState.episode.dream,'skipped');assert.equal(f.calls.length,0)
})
test('sleep suppresses autonomous activity; waking restores checks and provides a ten minute sleep grace',async t=>{
 const f=await fixture(t),user={id:'u',at:f.now()-4*HOUR};await f.service.sleep(f.id,'r',60,'休息',false)
 assert.equal(idleContactDue(f.store.snapshot(),f.c(),user,f.now(),'Asia/Shanghai'),false)
 await f.service.wake(f.id);assert.equal(idleContactDue(f.store.snapshot(),f.c(),user,f.now(),'Asia/Shanghai'),true)
 f.setRandom(0);f.advance(5*MIN);await f.service.tick();assert.equal(f.sleeping(),false)
})
test('tools enforce owner routes and keep dream privacy for shared session aliases',async t=>{
 const f=await fixture(t),tool=f.service.tool(f.id),signal=new AbortController().signal,exec={signal,agent:{session:{id:'s'}}}
 await assert.rejects(tool.execute({action:'sleep',minutes:30,reason:'睡觉'},{...exec,agent:{session:{id:'other-session'}}}),/自己的/)
 await f.store.update(s=>{s.companions[0].sleepState.dreams=[{id:'private',routeId:'other',narrative:'hidden'}]})
 assert.deepEqual(JSON.parse(await tool.execute({action:'inspect'},exec)).dreams,[])
 await tool.execute({action:'sleep',minutes:30,reason:'小睡',dream:false},exec);assert.equal(f.sleeping(),true);assert.deepEqual(f.c().capabilities,[])
 await tool.execute({action:'wake'},exec);assert.equal(f.sleeping(),false)
 await f.store.update(s=>{s.sessions.push({...s.sessions[0],id:'alias',kind:'channel'});s.companions[0].sleepState.dreams.push({id:'shared',routeId:'alias',at:f.now(),narrative:'shared'})})
 assert.deepEqual(JSON.parse(await tool.execute({action:'inspect'},exec)).dreams.map(d=>d.id),['shared'])
})
test('disabling sleep preserves completed records and stops sleep; partial dream edits preserve work-only defaults',async t=>{
 const f=await fixture(t);await f.service.sleep(f.id,'r',30,'休息');const previous=f.c()
 await f.store.update(s=>applyIdentity(s,s.companions[0],{sleepPolicy:{enabled:false}},previous.updatedAt,'ai'))
 assert.equal(f.sleeping(),false);assert.equal(f.c().identityDraft,undefined);assert.equal(pageIdentity(f.c()).sleepPolicy.enabled,false)
 await f.service.tick();assert.equal(f.c().sleepState.episode.wakeReason,'睡眠功能已关闭')
 await f.store.update(s=>{delete s.companions[0].sleepPolicy;delete s.companions[0].characterCard});const before=f.c()
 await f.store.update(s=>applyIdentity(s,s.companions[0],{sleepPolicy:{dreamsEnabled:false}},before.updatedAt,'ai'))
 assert.deepEqual(f.c().sleepPolicy,{enabled:false,dreamsEnabled:false})
})
