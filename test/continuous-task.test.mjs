import test from 'node:test'
import assert from 'node:assert/strict'
import {ContinuousService} from '../lib/continuous/service.js'
import {continuousUsage,validateContinuous} from '../lib/continuous/domain.js'
import {usageTotal,requestReservation,reviewContinuous} from '../lib/continuous/model.js'
import {activityPolicyCurrent} from '../lib/character/post-reply.js'
import {conversationContact,renderConversationTime} from '../lib/character/conversation-time.js'
import {installContinuousBudget} from '../lib/continuous/runtime.js'

function fixture(){
 let now=1800000000000,blocks=['文字直播 正在等待第一场开始'],busy=false,reviewCalls=0,wakes=0,cancels=0
 let result={scene:'比赛进行中',event:'出现新战况',evidence:'第一场已经开始了',speak:true,ended:false}
 const state={companions:[{id:'c',updatedAt:1,browser:{enabled:true,autonomous:true,updatedAt:1}}],sessions:[{id:'r',companionId:'c',sessionId:'s',kind:'local',userId:'local',channelId:'local'}],channels:[],pairings:[]}
 let queue=Promise.resolve()
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update(fn){const p=queue.then(()=>fn(state));queue=p.catch(()=>{});return p}}
 const browser={async run(owner,input,signal,guard){guard();signal.throwIfAborted();return {value:{url:'https://example.test/live',blocks}}}}
 const ports={review:async()=>{reviewCalls++;return result},wake:async()=>{if(busy)return false;wakes++;return true},busy:()=>busy,cancel:()=>{cancels++},warn:()=>{}}
 const service=new ContinuousService(store,browser,ports,()=>now)
 const create=(patch={})=>service.create('c',{routeId:'r',tabId:'t',title:'陪看',instruction:'看到新内容陪我讨论',until:'整场直播结束',...patch},'陪我一起看直播')
 const check=()=>service.check('c',service.task('c',state.companions[0].continuous.tasks[0].id),new AbortController().signal)
 return {service,state,store,browser,ports,create,check,advance:ms=>{now+=ms},blocks:v=>{blocks=v},busy:v=>{busy=v},result:v=>{result=v},counts:()=>({reviewCalls,wakes,cancels}),now:()=>now}
}
test('frequent clock/count/reorder updates cause no per-refresh calls; only bounded social checks remain',async()=>{
 const f=fixture();f.blocks(['文字直播 正在等待第一场开始','123 观看','12:30:30']);const t=await f.create()
 for(let i=0;i<180;i++){f.advance(20000);f.blocks([`${i+124} 观看`,'文字直播 正在等待第一场开始',`12:30:${i}`]);await f.check();if(i<40)assert.equal(f.counts().reviewCalls,0)}
 assert.ok(f.counts().reviewCalls<=4);assert.equal(f.counts().wakes,0);assert.equal(f.service.task('c',t.id).checks,181)
 validateContinuous(f.state.companions[0].continuous)
})
test('new updates batch once, repeated observations do not repeatedly wake, and busy chats still collect',async()=>{
 const f=fixture();await f.create();f.advance(180000);f.busy(true);f.blocks(['文字直播 正在等待第一场开始','第一场已经开始了']);await f.check()
 assert.equal(f.counts().reviewCalls,0);assert.equal(f.state.companions[0].continuous.tasks[0].pending.length,1)
 f.busy(false);await f.check();assert.equal(f.counts().wakes,1)
 for(let i=0;i<20;i++){f.advance(20000);await f.check()}
 assert.equal(f.counts().reviewCalls,1);assert.equal(f.counts().wakes,1)
})
test('time and shared conversation can initiate companionship without inventing new live events',async()=>{
 const f=fixture();const task=await f.create();let context
 f.ports.conversation=()=> '最近一次真实交流在十五分钟前，任务仍在进行'
 f.ports.review=async(c,t,s,facts)=>{context=facts;return {scene:t.scene,event:'想起对方',evidence:'',kind:'companionship',speak:true,ended:false,nextCheckMinutes:10}}
 f.advance(15*60000);await f.check();assert.match(context,/十五分钟/);assert.equal(f.counts().wakes,1)
 assert.equal(f.service.task('c',task.id).status,'running');assert.match(f.service.task('c',task.id).lastEvent,/不编造新战况/)
})
test('false evidence and normal reply completion never end a continuous task',async()=>{
 const f=fixture();const t=await f.create();f.advance(180000);f.blocks(['直播出现新战况了']);f.result({scene:'仍在进行',event:'结束了',evidence:'不存在的结束原文',speak:true,ended:true});await f.check()
 assert.equal(f.service.task('c',t.id).status,'running');assert.equal(f.counts().wakes,0);assert.equal(f.service.task('c',t.id).scene,t.scene)
})
test('explicit source ending closes task, and a stopped task cannot be resumed',async()=>{
 const f=fixture();const t=await f.create();f.advance(180000);f.blocks(['整场直播已经结束了']);f.result({scene:'结束',event:'结束',evidence:'整场直播已经结束了',speak:false,ended:true});await f.check()
 assert.equal(f.service.task('c',t.id).status,'completed');await assert.rejects(f.service.control('c',t.id,'resume'),/新建/)
})
test('stop during model judgment suppresses late wake and cancels current work',async()=>{
 const f=fixture();const t=await f.create();f.advance(180000);f.blocks(['第一场已经开始了']);let release,entered
 const started=new Promise(r=>{entered=r});f.ports.review=async()=>{entered();return new Promise(r=>{release=r})}
 const pending=f.check();await started;await f.service.control('c',t.id,'stop');release({scene:'新局面',event:'开场了',evidence:'第一场已经开始了',speak:true,ended:false});await pending
 assert.equal(f.counts().wakes,0);assert.equal(f.service.task('c',t.id).status,'stopped');assert.equal(f.counts().cancels,1)
})
test('permission revocation, changed browser instance and source navigation do not silently continue',async()=>{
 const f=fixture();const t=await f.create();f.state.companions[0].browser.updatedAt=2;f.advance(200000);await f.check()
 assert.equal(f.counts().reviewCalls,0);assert.equal(f.service.task('c',t.id).phase,'blocked')
})
test('shared hourly reservations are atomic, failed calls retain charges, exact usage includes cache',async()=>{
 const f=fixture();await f.create();await f.service.budget('c',10000)
 const ids=await Promise.all(Array.from({length:4},()=>f.service.reserve('c',4000,'review')))
 assert.equal(ids.filter(Boolean).length,2);assert.equal(continuousUsage(f.state.companions[0].continuous,f.now()),8000)
 await f.service.settle('c',ids.find(Boolean),2500);assert.equal(f.service.list('c').used,6500)
 assert.equal(usageTotal({inputTokens:10,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:40}),100)
 f.advance(3600001);assert.equal(f.service.list('c').used,0)
})
test('pending opportunities do not invoke judge repeatedly while conversation is busy',async()=>{
 const f=fixture();await f.create();f.advance(180000);f.blocks(['第一场已经开始了']);f.ports.wake=async()=>false;await f.check()
 for(let i=0;i<5;i++){f.advance(20000);await f.check()}
 assert.equal(f.counts().reviewCalls,1);assert.equal(f.service.list('c').tasks[0].phase,'ready')
})
test('model review has no tools or persona, bounded data, and accounts the failed stream',async()=>{
 const f=fixture();const t=await f.create();t.pending=['第一场已经开始了'];let options
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(o){options=o;yield {type:'text-delta',text:JSON.stringify({kind:'scene',scene:'场景',event:'开场',evidence:t.pending[0],speak:true,ended:false})};yield {type:'usage',usage:{inputTokens:123,outputTokens:80}};yield {type:'finish',reason:{kind:'stop'}}}}}
 await reviewContinuous(ctx,f.service,f.state.companions[0],t,new AbortController().signal)
 assert.equal(options.tools,undefined);assert.equal(options.messages.length,1);assert.equal(options.maxTokens,500);assert.equal(f.service.list('c').used,203)
 assert.ok(requestReservation(options)>203)
})
test('continuous delivery policy is scoped, revocable and independent of free idle greetings',async()=>{
 const f=fixture();const t=await f.create(),c=f.state.companions[0],r=f.state.sessions[0]
 r.idleContactState={kind:'continuous',continuousTaskId:t.id,continuousRevision:t.revision}
 assert.equal(activityPolicyCurrent(f.state,c,r,f.now()),true)
 await f.service.control('c',t.id,'stop');assert.equal(activityPolicyCurrent(f.state,c,r,f.now()),false)
})
test('conversation contact counts confirmed autonomous rounds only, not parts or other routes',()=>{
 const now=1800000000000,r={id:'r',kind:'channel',channelId:'qq',userId:'u',sessionId:'s',inboundMessageIds:['user']},events=[{type:'user/message',time:now-600000,data:{id:'user',source:{kind:'user'},content:[]}}]
 const record=(id,routeId,sentParts)=>({createdAt:now-60000,reply:{idleContactOrigin:{messageId:id,routeId,sessionId:'s'}},targets:[{channelId:'qq',userId:'u',sentParts}]})
 const rows=[record('one','r',[0,1]),record('one','r',[2]),record('two','r',[]),record('other','else',[0])]
 assert.equal(conversationContact(r,events,rows,now).unanswered,1)
 events.push({type:'user/message',time:now,data:{id:'user',source:{kind:'user'},content:[]}})
 assert.equal(conversationContact(r,events,rows,now).unanswered,0)
})
test('main conversation budget meters all automatic steps and leaves unrelated chats untouched',async()=>{
 const f=fixture();const task=await f.create(),listeners=new Map(),claim={owner:'c',task,steps:0}
 const dispose=installContinuousBudget({on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)}},{continuousClaim:id=>id==='s'?claim:undefined},f.service)
 const options={sessionId:'s',messages:[{role:'user',content:[{type:'text',text:'新的直播场景'}]}],maxTokens:700}
 const next=async function*(){yield {type:'usage',usage:{inputTokens:100,outputTokens:20}};yield {type:'finish',reason:{kind:'stop'}}}
 for await(const c of listeners.get('llm/stream')(options,next)){}
 assert.equal(claim.steps,1);assert.equal(f.service.list('c').used,120)
 for await(const c of listeners.get('llm/stream')({...options,sessionId:'other'},next)){}
 assert.equal(claim.steps,1)
 claim.steps=3;await assert.rejects(async()=>{for await(const c of listeners.get('llm/stream')(options,next)){}},/上限/)
 dispose();assert.equal(listeners.size,0)
})

test('restart invalidates pending speech but retains observation baseline and hourly costs',async()=>{
 const f=fixture(),t=structuredClone(await f.create());await f.service.reserve('c',1000,'review')
 await f.service.patch('c',t.id,t.revision,row=>{row.claim={messageId:'old',revision:row.revision,at:f.now()};row.pendingEvent={text:'旧接话',evidence:'旧证据',at:f.now()}})
 await f.service.recover();const current=f.service.task('c',t.id)
 assert.equal(current.revision,t.revision+1);assert.equal(current.claim,undefined);assert.equal(current.pendingEvent,undefined);assert.deepEqual(current.seen,t.seen);assert.equal(f.service.list('c').used,1000)
 await f.service.close();assert.equal(f.counts().cancels,1)
})

test('background compaction and title requests do not bypass the continuous budget',async()=>{
 const f=fixture(),task=await f.create(),listeners=new Map(),claim={owner:'c',task,steps:0}
 installContinuousBudget({on:(name,fn)=>{listeners.set(name,fn);return()=>{}}},{continuousClaim:()=>claim},f.service)
 await f.service.budget('c',10000)
 const next=async function*(){assert.fail('over-budget request must not reach provider')}
 await assert.rejects(async()=>{for await(const chunk of listeners.get('llm/stream')({sessionId:'s',purpose:'compaction',messages:[{role:'user',content:'x'.repeat(12000)}]},next)){}},/预算/)
})
