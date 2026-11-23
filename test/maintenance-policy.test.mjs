import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {createDefaultCompanion} from '../lib/domain.js'
import {DailyReviewScheduler} from '../lib/daily-review.js'
import {registerPartnerConcernTool} from '../lib/concern-tool.js'
import {conversationOrigin,questionOrigin} from '../lib/channels/question-origin.js'
import {recordInputOrigin} from '../lib/channels/input-origin.js'
import {MemoryWorker} from '../lib/memory-worker.js'

test('disabled role chat cannot let a saved rolling preference suppress renewal',async()=>{
 const c={...createDefaultCompanion(),id:'c'}
 delete c.characterCard
 Object.assign(c.automation.memory,{enabled:false,rollingContextEnabled:true,contextRenewalEnabled:true})
 let calls=0
 const scheduler=new DailyReviewScheduler({logger:{warn(){},error(){}}},
  {snapshot:()=>({companions:[c],sessions:[]}),isCompanionRemoving:()=>false},{},{},
  {isCompanionBusy:()=>false,renewReviewedContexts:async()=>{calls++;return 1}})
 try{const result=await scheduler.trigger('c',false,true);assert.equal(result.reason,undefined);assert.equal(calls,1)}finally{await scheduler.close()}
})

test('shared concern writes use the author regardless of route ordering and bounded ID eviction',async()=>{
 const session=Session.create('concern-origin')
 const user=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'帮我关注项目 A 的版本变化'}]})
 const local={id:'local',kind:'local',companionId:'c',sessionId:session.id,channelId:'@local',userId:'owner:c'}
 const channel={id:'qq',kind:'channel',companionId:'c',sessionId:session.id,channelId:'qq',userId:'123',inboundMessageIds:[user.id]}
 recordInputOrigin(session,{messageId:user.id,routeId:'qq',channelId:'qq',userId:'123'})
 session.append('user/message',user,{surfaceOp:'append'})
 const state={companions:[{...createDefaultCompanion(),id:'c'}],sessions:[local,channel]},scopes=[]
 let tool
 const store={snapshot:()=>structuredClone(state)}
 const dispose=registerPartnerConcernTool({tools:{register(value){if(value.name==='partner_concern_suggest')tool=value;return ()=>{}}},agents:{list:()=>[]},on:()=>()=>{}},store,
  {async ingestCandidates(_id,scope){scopes.push(scope);return {entries:[]}}})
 const input={subject:'项目 A 版本变化',reason:'持续留意',evidence:'帮我关注项目 A 的版本变化',watchKind:'web',watchQuery:'版本',priority:.8,confidence:1}
 try{
  await tool.execute(input,{agent:{session}});state.sessions.reverse();await tool.execute(input,{agent:{session}})
  channel.inboundMessageIds=[];await tool.execute(input,{agent:{session}})
  assert.deepEqual(scopes,['qq:123','qq:123','qq:123'])
  assert.equal(questionOrigin(session.id,session.snapshotEvents(),state.sessions).id,'qq')
  state.sessions=[local]
  assert.equal(conversationOrigin(session.id,session.snapshotEvents(),state.sessions),undefined,'revoked origin must not become local')
 }finally{dispose()}
})

test('idle memory polls back off while new work wakes promptly and cannot restart after shutdown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let calls=0
 const c={id:'c',automation:{memory:{enabled:true}}}
 const worker=new MemoryWorker({companions:()=>[c],removing:()=>false,warn(){},async process(){calls++}})
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
 try{
  worker.start();t.mock.timers.tick(1000);await settle();assert.equal(calls,1)
  t.mock.timers.tick(5000);await settle();assert.equal(calls,1)
  t.mock.timers.tick(5000);await settle();assert.equal(calls,2)
  worker.wake();t.mock.timers.tick(1000);await settle();assert.equal(calls,3)
  worker.wake();worker.wake();t.mock.timers.tick(1000);await settle();assert.equal(calls,4)
  await worker.close();worker.wake();t.mock.timers.tick(60000);await settle();assert.equal(calls,4)
 }finally{await worker.close();t.mock.timers.reset()}
})
test('a wake during extraction schedules the next pass without starting a concurrent one',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let calls=0,release
 const gate=new Promise(r=>{release=r}),settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
 const worker=new MemoryWorker({companions:()=>[{id:'c',automation:{memory:{enabled:true}}}],removing:()=>false,warn(){},async process(){calls++;if(calls===1)await gate}})
 try{
  worker.start();t.mock.timers.tick(1000);await settle();assert.equal(calls,1)
  worker.wake();t.mock.timers.tick(60000);await settle();assert.equal(calls,1)
  release();await settle();t.mock.timers.tick(1000);await settle();assert.equal(calls,2)
 }finally{release();await worker.close();t.mock.timers.reset()}
})
