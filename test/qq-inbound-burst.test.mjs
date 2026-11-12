import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {QqGroupBursts,groupBurstEvent} from '../lib/channels/qq/inbound-burst.js'
import {DirectDispatcher} from '../lib/channels/direct/dispatcher.js'
import {pendingGroupInput} from '../lib/channels/qq/pending-input.js'
const event=(id,text=id,user='22345678',group='99887766')=>({id,text,sender:`group:${group}:${user}`,targetId:`group:${group}`,qqGroup:{groupId:group,userId:user,senderName:'成员',mentioned:false,autonomous:true}})
function fixture(){const controller=new AbortController(),errors=[];const dispatcher=new DirectDispatcher(controller.signal,e=>errors.push(e));const bursts=new QqGroupBursts(dispatcher,controller.signal,30,90);return {controller,dispatcher,bursts,errors}}
test('same speaker bursts across polls coalesce text and attachments, without blocking other lanes',async()=>{
 const f=fixture(),seen=[]
 const run=async(messages,ready)=>{seen.push(messages.map(m=>m.id));ready()}
 f.bursts.enqueue([event('a')],run)
 f.dispatcher.enqueue(['private'],'queue',async ready=>{seen.push(['private']);ready()},'private')
 await delay(10)
 f.bursts.enqueue([{...event('b'),media:[{source:'image'}]}],run)
 f.bursts.enqueue([event('b')],run)
 assert.equal(f.bursts.has('b'),true)
 await f.dispatcher.drain()
 assert.deepEqual(seen,[['private'],['a','b']]);assert.equal(f.bursts.has('b'),false);assert.deepEqual(f.errors,[])
})
test('different speakers, rooms and referenced messages never merge',async()=>{
 const f=fixture(),seen=[],run=async(m,ready)=>{seen.push(m.map(x=>x.id));ready()}
 for(const m of [event('a'),event('b','b','33445678'),event('c','c','22345678','88776655'),{...event('d'),qqGroup:{...event('d').qqGroup,replyToId:'other-message'}}])f.bursts.enqueue([m],run)
 await f.dispatcher.drain();assert.equal(seen.length,4);assert.ok(seen.every(m=>m.length===1))
})
test('active reply permits next merged input to prepare before the old reply ends',async()=>{
 const f=fixture(),seen=[];let finish,started
 const active=new Promise(r=>started=r),end=new Promise(r=>finish=r)
 f.bursts.enqueue([event('first')],async(_m,ready)=>{seen.push('first');ready();started();await end;seen.push('end')})
 await active
 f.bursts.enqueue([event('second')],async(m,ready)=>{seen.push(m.map(x=>x.id).join('+'));ready();finish()})
 f.bursts.enqueue([event('third')],async()=>assert.fail('must merge into second'))
 await f.dispatcher.drain();assert.deepEqual(seen,['first','second+third','end'])
})
test('burst count is bounded and cancellation releases buffers without dispatching',async()=>{
 const f=fixture(),sizes=[],run=async(m,ready)=>{sizes.push(m.length);ready()}
 for(let i=0;i<18;i++)f.bursts.enqueue([event(String(i))],run)
 await f.dispatcher.drain();assert.deepEqual(sizes,[16,2])
 const aborted=fixture();aborted.bursts.enqueue([event('cancel')],async()=>assert.fail('cancelled batch'))
 aborted.controller.abort();await aborted.dispatcher.drain();assert.equal(aborted.bursts.has('cancel'),false);assert.deepEqual(aborted.errors,[])
})
test('whole burst routing retains a later direct mention and all text',()=>{
 const a=event('a','那个'),b=event('b','帮我看看');b.qqGroup.mentioned=true
 const merged=groupBurstEvent([a,b],'那个\n\n帮我看看')
 assert.equal(merged.qqGroup.mentioned,true);assert.equal(merged.text,'那个\n\n帮我看看');assert.equal(a.qqGroup.mentioned,false)
})
test('only pending verified user input from the same group speaker holds old tool calls',()=>{
 const state={channels:[{id:'c',platform:'qq'}],sessions:[{id:'r',sessionId:'s',channelId:'c',userId:'group:99887766:22345678',inboundMessageIds:['new']}]}
 const agent={session:{id:'s'},inbox:{nextStep:[{id:'new',source:{kind:'user'}}]}}
 assert.equal(pendingGroupInput(state,agent,'r'),true)
 for(const edit of [()=>agent.inbox.nextStep=[],()=>agent.inbox.nextStep=[{id:'other',source:{kind:'user'}}],()=>agent.inbox.nextStep=[{id:'new',source:{kind:'plugin:test'}}]]){edit();assert.equal(pendingGroupInput(state,agent,'r'),false)}
 agent.inbox.nextStep=[{id:'new',source:{kind:'user'}}];state.sessions[0].userId='22345678';assert.equal(pendingGroupInput(state,agent,'r'),false)
})
