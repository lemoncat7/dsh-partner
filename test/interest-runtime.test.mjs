import test from 'node:test'
import assert from 'node:assert/strict'
import {installInterestLimit,recoverInterest} from '../lib/character/interest-runtime.js'
test('interest requests are bounded; normal user requests keep their original options',async()=>{
 const hooks=new Map(),ctx={on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name)}},claim={valid:true,counter:{steps:0}},limited=[]
 let current=claim
 const agents={interestClaim:id=>id==='s'?current:undefined,interestLimit:async(id,reason)=>limited.push(reason)}
 const dispose=installInterestLimit(ctx,agents),request=hooks.get('agent/request'),stream=hooks.get('llm/stream')
 assert.equal((await request({agent:{session:{id:'s'}}},async()=>({maxTokens:9000}))).maxTokens,800)
 assert.equal((await request({agent:{session:{id:'user'}}},async()=>({maxTokens:9000}))).maxTokens,9000)
 const consume=async(id)=>{const chunks=[];for await(const c of stream({sessionId:id},async function*(){yield {type:'text-delta',text:'ok'}}))chunks.push(c);return chunks}
 for(let i=0;i<4;i++)assert.equal((await consume('s')).length,1)
 await assert.rejects(consume('s'),/上限/);assert.equal(limited.length,1)
 assert.equal((await consume('user')).length,1)
 current=undefined;assert.equal((await consume('s')).length,1)
 dispose();assert.equal(hooks.size,0)
})
test('restart retires unconfirmed interest wakes without replaying a message or changing explicit plans',async()=>{
 const explicit={id:'explicit',status:'pending'},p={trigger:'interest',status:'waiting'},route={idleContactState:{planSnapshot:{trigger:'interest'}}}
 const state={companions:[{activityPlan:explicit},{activityPlan:p}],sessions:[route]}
 await recoverInterest({snapshot:()=>state,update:async fn=>fn(state)})
 assert.equal(explicit.status,'pending');assert.equal(p.status,'cancelled');assert.equal(route.idleContactState.cancelled,true)
})

test('new user input stops the old interest stream normally and discards its remaining chunks',async()=>{
 const hooks=new Map(),stopped=[],claim={messageId:'old-idle',valid:true,counter:{steps:0}};let current=claim
 installInterestLimit({on:(name,fn)=>{hooks.set(name,fn);return()=>{}}},{interestClaim:()=>current,stopInterest:(...args)=>stopped.push(args)})
 const chunks=[]
 for await(const chunk of hooks.get('llm/stream')({sessionId:'s'},async function*(){yield 'first';current=undefined;yield 'stale'}))chunks.push(chunk)
 assert.deepEqual(chunks,['first']);assert.deepEqual(stopped,[['s','old-idle']])
})

test('interest cancellation uses the host abort while preserving queued inputs and never aborts a newer turn',async()=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const {IDLE_CONTACT_NOTICE}=await import('../lib/character/idle-contact.js')
 const cancels=[],events=[{type:'user/message',data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 const agent={status:'running',session:{snapshotEvents:()=>events},cancel:(...args)=>cancels.push(args)}
 const runtime=new PartnerAgentRuntime({}, {snapshot:()=>({companions:[],sessions:[]}),subscribe:()=>()=>{}}, '/tmp');runtime.restoredCompositions.set('s',{agent})
 runtime.stopInterest('s','idle');assert.equal(cancels.length,1);assert.deepEqual(cancels[0][1],{keepInbox:true})
 events.push({type:'user/message',data:{id:'new',source:{kind:'user'}}});runtime.stopInterest('s','idle');assert.equal(cancels.length,1)
})
