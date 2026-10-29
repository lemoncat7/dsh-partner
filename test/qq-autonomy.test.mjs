import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy} from '../lib/channels/qq/autonomy.js'
import {scoreGroupReply,topicSimilarity} from '../lib/channels/qq/reply-rules.js'
const event={id:'one',sender:'group:12345678:22345678',text:'小明你怎么看？',qqGroup:{groupId:'12345678',userId:'22345678',senderName:'朋友',autonomous:true,mentioned:false}}
const companion={name:'小明',role:'朋友',instructions:'自然聊天'}
const context={name:'小明',owner:false,affection:0,now:1000000,seed:'test'}
const signal=()=>new AbortController().signal
const forbidden={get(){throw Error('must not resolve a model')},llm:{stream(){throw Error('must not call a model')}}}
test('every admitted message is locally evaluated, direct names reply and acknowledgements stay silent without a model',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now)
 for(const [text,expected] of [['小明你怎么看？',true],['好的',false],['这件事说不准',false],['小明！',true]]){
  const input={...event,text};gate.observe('c',input)
  assert.equal(await gate.shouldReply('c',input,companion,signal()),expected)
  assert.equal(gate.status('c').method,'local')
 }
 assert.equal(await gate.shouldReply('c',{...event,qqGroup:{...event.qqGroup,mentioned:true}},companion,signal()),true)
 assert.equal(gate.status('c').score,100)
})
test('provenance and direct addressing take precedence over fuzzy hints',()=>{
 assert.equal(scoreGroupReply({...event,text:'好的',qqGroup:{...event.qqGroup,mentioned:true}},context).reply,true)
 assert.equal(scoreGroupReply({...event,text:'小明天去不去'},context).score<100,true,'name embedded in another phrase is not direct invocation')
 const other=scoreGroupReply({...event,text:'小明你在吗？',qqGroup:{...event.qqGroup,otherMention:true}},{...context,owner:true,affection:100,recent:{at:context.now,text:'小明你在吗'}})
 assert.equal(other.reply,false)
 const guest=scoreGroupReply({...event,text:'弟弟呢？'},context)
 const owner=scoreGroupReply({...event,text:'弟弟呢？'},{...context,owner:true,affection:20})
 assert.equal(owner.reply,true);assert.ok(owner.score>guest.score)
})
test('Dice topic similarity and longer-name edit distance are bounded',()=>{
 assert.equal(topicSimilarity('动漫游戏','动漫游戏'),1)
 assert.equal(topicSimilarity('动漫游戏','服务器磁盘'),0)
 assert.equal(topicSimilarity('',''),0)
 assert.ok(topicSimilarity('今天一起玩游戏','一起玩游戏吗')>0)
 assert.ok(scoreGroupReply({...event,text:'星际旅刑者，你在吗'},{...context,name:'星际旅行者'}).reasons.some(r=>r.includes('近似角色名')))
 assert.ok(!scoreGroupReply({...event,text:'小王你好'},context).reasons.some(r=>r.includes('近似角色名')))
})
test('uncertain outcomes use a stable draw and a linearly scaled probability',()=>{
 const input={...event,text:'hello'}
 const result=scoreGroupReply(input,{...context,owner:true})
 assert.equal(result.score,45);assert.equal(result.probability,(45-30)/35)
 for(let i=0;i<10;i++)assert.deepEqual(scoreGroupReply(input,{...context,owner:true}),result)
 let accepted=0
 for(let i=0;i<1000;i++)if(scoreGroupReply(input,{...context,owner:true,seed:String(i)}).reply)accepted++
 assert.ok(accepted>350&&accepted<510,'draws follow the intended probability without rerolling a message')
})
test('only successful replies open a continuation window; other speakers, groups and time do not inherit it',async()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now)
 const input={...event,text:'你现在在干什么？'}
 gate.observe('c',input);await gate.shouldReply('c',input,companion,signal());const before=gate.status('c').score
 gate.replied('c',input,'我在看动漫，你呢？');await gate.shouldReply('c',input,companion,signal());const after=gate.status('c').score
 assert.ok(after>before);assert.equal(gate.status('c').probability,1)
 now+=60000;await gate.shouldReply('c',input,companion,signal());assert.ok(gate.status('c').score<after)
 now+=60001;await gate.shouldReply('c',input,companion,signal());assert.equal(gate.status('c').score,before)
 gate.replied('c',input);gate.observe('c',{...input,qqGroup:{...input.qqGroup,userId:'33445678'}});gate.observe('c',input)
 await gate.shouldReply('c',input,companion,signal());assert.equal(gate.status('c').score,before)
 gate.replied('c',input);await gate.shouldReply('other-channel',input,companion,signal());assert.equal(gate.status('other-channel').score,before)
})
test('observations remain bounded and cancellation cannot start scoring or model work',async()=>{
 const gate=new QqGroupAutonomy(forbidden)
 for(let i=0;i<100;i++)gate.observe('c',{...event,text:'message-'+i})
 assert.equal(JSON.parse(gate.context('c',event)).length,15)
 const controller=new AbortController();controller.abort()
 await assert.rejects(gate.shouldReply('c',event,companion,controller.signal))
})
