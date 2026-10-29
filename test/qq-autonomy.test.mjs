import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy} from '../lib/channels/qq/autonomy.js'
const event={text:'小明你怎么看？',qqGroup:{groupId:'12345678',userId:'22345678',senderName:'朋友',autonomous:true,mentioned:false}}
const companion={name:'小明',role:'朋友',instructions:'自然聊天'}
test('group autonomy can remain silent, never calls tools, and applies a bounded pause between decisions',async()=>{
 let now=100000,decision=false,calls=0
 const gate=new QqGroupAutonomy({get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(req){calls++;assert.equal(req.tools,undefined);yield {type:'text-delta',text:JSON.stringify({reply:decision})};yield {type:'finish',reason:{kind:'stop'}}}}},()=>now)
 gate.observe('c',event)
 assert.equal(await gate.shouldReply('c',event,companion,AbortSignal.timeout(1000)),false)
 decision=true;assert.equal(await gate.shouldReply('c',event,companion,AbortSignal.timeout(1000)),false);assert.equal(calls,1)
 now+=16000;assert.equal(await gate.shouldReply('c',event,companion,AbortSignal.timeout(1000)),true)
 now+=16000;assert.equal(await gate.shouldReply('c',event,companion,AbortSignal.timeout(1000)),false);assert.equal(calls,2)
 assert.equal(await gate.shouldReply('c',{...event,qqGroup:{...event.qqGroup,mentioned:true}},companion,AbortSignal.timeout(1000)),true)
})
test('malformed or incomplete decisions fail silent and observations stay bounded',async()=>{
 const gate=new QqGroupAutonomy({get:()=>({currentSelection:()=>({})}),llm:{async *stream(){yield {type:'text-delta',text:'{"reply":true}'}}}},()=>100000)
 for(let i=0;i<100;i++)gate.observe('c',{...event,text:'message-'+i})
 assert.equal(JSON.parse(gate.context('c',event)).length,15)
 assert.equal(await gate.shouldReply('c',event,companion,AbortSignal.timeout(1000)),false)
})
