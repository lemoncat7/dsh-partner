import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy} from '../lib/channels/qq/autonomy.js'
import {scoreGroupReply,routeGroupReply,CONVERSATION_WINDOW_MS} from '../lib/channels/qq/reply-rules.js'
const event={id:'one',sender:'group:12345678:22345678',text:'小明你怎么看？',qqGroup:{groupId:'12345678',userId:'22345678',senderName:'朋友',autonomous:true,mentioned:false}}
const companion={name:'小明',relationshipText:'用户是哥哥，角色是弟弟'}
const context={name:'小明',owner:true,addresses:['弟弟'],affection:20,now:1000000,seed:'test'}
const signal=()=>new AbortController().signal
const forbidden={get(){throw Error('must not resolve a remote model')}}
const unavailable=async()=>undefined
const input=(text,group={},id=text)=>({...event,id,text,qqGroup:{...event.qqGroup,...group}})

test('explicit calling and validated reply relationships take precedence over semantics',()=>{
 for(const text of ['小明？','小明你怎么看','弟弟 弟弟','弟弟人呢？']){
  const result=scoreGroupReply(input(text),context);assert.equal(result.reply,true,text);assert.equal(result.route,'direct')
 }
 assert.equal(routeGroupReply(input('小明天去不去'),context),undefined)
 assert.equal(scoreGroupReply(input('你好',{otherMention:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('小明？',{replyTo:'other',hasReply:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('嗯',{replyTo:'self',hasReply:true}),context).route,'direct')
 assert.equal(scoreGroupReply(input('你好',{otherMention:true,mentioned:true}),context).reply,true)
 assert.equal(routeGroupReply(input('弟弟人呢？'),{...context,owner:false}),undefined,'relationship terms never prove ownership')
})
test('recent real conversation accepts arbitrary followups without semantic calls or random draws',async()=>{
 let calls=0;const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);assert.equal(await gate.shouldReply('c',first,companion,signal()),true);gate.replied('c',first,'刚刚回来了')
 for(const text of ['哇 太棒了','然后呢','我都没说那个','好的','😀','That is awesome!','え、すごいね']){
  const e=input(text);gate.observe('c',e);assert.equal(await gate.shouldReply('c',e,companion,signal()),true,text)
  assert.equal(gate.status('c').route,'continuation')
 }
 assert.equal(calls,0)
})
test('another speaker does not erase a thread or inherit it; channels, groups and expiry are separate',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'刚刚回来了')
 const other=input('天气不错',{userId:'33445678'});gate.observe('c',other);await gate.shouldReply('c',other,companion,signal());assert.equal(gate.status('c').route,'fallback')
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'continuation')
 await gate.shouldReply('other-channel',follow,companion,signal());assert.equal(gate.status('other-channel').route,'fallback')
 await gate.shouldReply('c',input('太棒了',{groupId:'87654321'}),companion,signal());assert.equal(gate.status('c').route,'fallback')
 now+=CONVERSATION_WINDOW_MS;await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback');assert.equal(calls,4)
})
test('only delivery establishes continuity, redirect and explicit stopping close the correct thread',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 const first=input('小明？');gate.observe('c',first);await gate.shouldReply('c',first,companion,signal())
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','mere admission is not a reply')
 gate.replied('c',first,'你好')
 const redirect=input('你在吗',{otherMention:true});gate.observe('c',redirect)
 gate.replied('c',first,'late delivery');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','late old send does not reopen redirected thread')
 gate.observe('c',first);gate.replied('c',first,'你好')
 const stop=input('不用回复了');gate.observe('c',stop);assert.equal(await gate.shouldReply('c',stop,companion,signal()),false)
 gate.replied('c',stop,'');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback')
})
test('uncertain semantics and outages fail open; only clear negative classifications reject new conversation',()=>{
 for(const semantic of [undefined,{label:'other',confidence:.6,margin:.3},{label:'close',confidence:.8,margin:.15},{label:'address',confidence:.8,margin:.5},{label:'engage',confidence:.8,margin:.5}]){
  assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic}).reply,true)
 }
 for(const label of ['other','close','background'])assert.equal(scoreGroupReply(input('普通消息'),{...context,semantic:{label,confidence:.9,margin:.6}}).reply,false)
 assert.equal(scoreGroupReply(input('好的'),context).reply,false)
 assert.equal(scoreGroupReply(input('好的'),{...context,recent:{at:context.now,text:'你来了吗'}}).reply,true)
})
test('all admitted messages are evaluated even while classifier is unavailable; cancellation remains cancellation',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{throw Error('service down')})
 assert.equal(await gate.shouldReply('c',input('我来了'),companion,signal()),true)
 const controller=new AbortController();controller.abort()
 await assert.rejects(gate.shouldReply('c',event,companion,controller.signal))
 const lateController=new AbortController(),late=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{lateController.abort();return undefined})
 await assert.rejects(late.shouldReply('c',input('我来了'),companion,lateController.signal))
})
test('bounded observations exclude the current and later events from the context of a queued message',()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 for(let i=0;i<100;i++)gate.observe('c',input('message-'+i,{},String(i)))
 const context=JSON.parse(gate.context('c',input('message-98',{},'98')))
 assert.equal(context.length,16);assert.equal(context.at(-1).text,'message-97')
})
