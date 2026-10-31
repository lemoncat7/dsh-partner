import test from 'node:test'
import assert from 'node:assert/strict'
import {replyContinuity,renderReplyContinuity,confirmedProgress} from '../lib/chat/reply-continuity.js'
const user=(seq,id)=>({seq,type:'user/message',data:{id,source:{kind:'user'},content:[{type:'text',text:id}]}})
const snapshot=(seq,text)=>({seq,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot',sections:[{name:'partner-conversation-memory',text}]},content:[]}})
const progress=(seq,id,text)=>({seq,type:'tool/ptc-dispatch',data:{name:'partner_chat_progress',subCallId:id,arguments:{text},content:[{type:'text',text:'{"delivered":true}'}]}})
test('continuity isolates channel recipients and rejects failed or unknown progress delivery',()=>{
 const routes=[{id:'a',kind:'channel',sessionId:'s',inboundMessageIds:['ua']},{id:'b',kind:'channel',sessionId:'s',inboundMessageIds:['ub']}]
 const es=[user(1,'ua'),snapshot(2,'【当前休息状态】A的记录'),{seq:2.5,type:'tool/ptc-dispatch-start',data:{subCallId:'pa'}},progress(3,'pa','只对A说'),user(4,'ub'),snapshot(5,'【当前休息状态】B的记录'),{seq:5.5,type:'tool/ptc-dispatch-start',data:{subCallId:'pb'}},progress(6,'pb','只对B说')]
 const context=replyContinuity('s',es,routes)
 assert.deepEqual(context.confirmedMessages,[{seq:6,text:'只对B说'}]);assert.deepEqual(context.historicalSleep,[{seq:5,text:'【当前休息状态】B的记录'}])
 assert.ok(!renderReplyContinuity('s',es,routes).includes('A的记录'))
 es.at(-1).data.isError=true;assert.equal(replyContinuity('s',es,routes).confirmedMessages.length,0)
 es.at(-1).data.isError=false;es.at(-1).data.content=[{type:'text',text:'sending'}];assert.equal(replyContinuity('s',es,routes).confirmedMessages.length,0)
})
test('nested progress is deduplicated and old state does not grow indefinitely',()=>{
 const es=[user(1,'first'),snapshot(2,'【当前休息状态】过期'),progress(3,'p','已送达'),progress(4,'p','重复')]
 assert.equal(confirmedProgress(es).size,1)
 for(let seq=5;seq<15;seq++)es.push(user(seq,'u'+seq))
 assert.deepEqual(replyContinuity('s',es,[]).historicalSleep,[])
 assert.deepEqual(replyContinuity('s',es,[]).confirmedMessages,[])
})

test('progress completed after another recipient arrives retains call-origin audience',()=>{
 const routes=[{id:'a',kind:'channel',sessionId:'s',inboundMessageIds:['ua']},{id:'b',kind:'channel',sessionId:'s',inboundMessageIds:['ub']}]
 const es=[user(1,'ua'),{seq:2,type:'tool/call',data:{callId:'p',name:'partner_chat_progress',arguments:{text:'A的任务'}}},user(3,'ub'),{seq:4,type:'tool/result',data:{message:{toolCallId:'p',content:[{type:'text',text:'{"delivered":true}'}]}}}]
 assert.deepEqual(replyContinuity('s',es,routes).confirmedMessages,[])
})
