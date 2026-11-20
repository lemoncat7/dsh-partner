import test from 'node:test'
import assert from 'node:assert/strict'
import {chooseCandidates,editedLabels,labelSamples,splitSamples} from '../lib/channels/qq/attention-samples.js'
import {qqHistorySamples,readQqTrainingHistory} from '../lib/channels/qq/attention-group-training.js'

test('sample prompts expose local speaker numbers and scrub common identifiers',async()=>{
 const at=Date.now()
 const candidates=chooseCandidates([
  {id:'private-message-id',sender:'1234567',text:'你好，邮箱 someone@example.org',at,recipient:'unknown'},
  {id:'quoted-message-id',sender:'7654321',text:'伙伴在吗 https://example.org/secret',at:at+1,recipient:'partner'},
 ],at-100)
 let request
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(options){
  request=JSON.stringify(options.messages)
  yield {type:'text-delta',text:'[{"id":0,"intent":"wrong","scene":"share"},{"id":1,"intent":"other","scene":"other"}]'}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const result=await labelSamples(ctx,{name:'伙伴'},candidates,AbortSignal.timeout(1000),()=>{})
 assert.doesNotMatch(request,/1234567|7654321|private-message-id|someone@example|example.org/)
 assert.equal(result[0].intent,null)
 assert.equal(result[1].intent,'address')
 assert.equal(result[1].scene,'address')
})

test('review edits preserve text and time, chronological holdout stays disjoint',()=>{
 const rows=Array.from({length:52},(_,id)=>({id,text:'样本'+id,at:100_000+id*100_000,
  intent:id%2?'engage':'other',scene:id%2?'banter':'other'}))
 const clean=editedLabels(rows,[{id:0,intent:'address',scene:'address',text:'ignore',at:0},{id:3,remove:true}])
 assert.equal(clean[0].text,'样本0')
 assert.equal(clean[0].at,100_000)
 assert.throws(()=>editedLabels(rows,[{id:1,intent:'bad',scene:'banter'}]))
 const split=splitSamples(clean)
 const held=new Set(split.holdout.intent.map(row=>row.text))
 assert.ok(held.size>=10)
 assert.ok(split.train.intent.every(row=>!held.has(row.text)))
 assert.throws(()=>splitSamples(clean.map(row=>({...row,at:500_000}))))
})

test('history ignores other rooms and marks only verified group reply targets',()=>{
 const text={type:'text',data:{text:'这是内容'}}
 const segment=id=>({type:'reply',data:{id}})
 const rows=[
  {message_id:1,group_id:'12345',user_id:'60000',message:[text]},
  {message_id:2,group_id:'12345',user_id:'70000',message:[segment(1),text]},
  {message_id:3,group_id:'88888',user_id:'60000',message:[text]},
  {message_id:4,group_id:'12345',user_id:'70000',message:[segment(3),text]},
 ].map(row=>({...row,time:Math.floor(Date.now()/1000)}))
 assert.deepEqual(qqHistorySamples({messages:rows},'12345','60000').map(row=>[row.id,row.recipient]),[['2','partner'],['4','unknown']])
})

test('aliases come from settings and private relationships only reach verified samples',async()=>{
 const at=Date.now()
 const candidates=chooseCandidates([
  {id:'before',sender:'50001',text:'私称，你在吗',at,recipient:'unknown'},
  {id:'bound',sender:'50002',text:'私称，你来看这事',at:at+1,recipient:'partner'},
  {id:'public',sender:'50003',text:'小泡，在吗',at:at+2,recipient:'partner'},
 ],at-100,['50002'])
 const inputs=[]
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(options){
  const input=JSON.parse(options.messages[0].content[0].text)
  inputs.push(input)
  yield {type:'text-delta',text:JSON.stringify(input.rows.map(row=>({id:row.id,intent:'address',scene:'address',alias:row.text.split('，')[0]})))}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const rows=await labelSamples(ctx,{name:'伙伴',role:'外号叫小泡',relationshipText:'对方私下喊我私称'},candidates,AbortSignal.timeout(1000),()=>{})
 assert.equal(inputs.length,2)
 assert.equal(inputs[0].relationshipNames,undefined)
 assert.deepEqual(inputs[1].relationshipNames,['对方私下喊我私称'])
 assert.equal(rows.find(row=>row.id===0).alias,undefined)
 assert.equal(rows.find(row=>row.id===2).alias,'小泡')
 assert.equal(rows.find(row=>row.id===1).relationshipAlias,true)
 assert.equal(rows.find(row=>row.id===1).alias,'私称')
})

test('training uses real older records and normalizes relationship-only aliases',()=>{
 const rows=Array.from({length:52},(_,id)=>({id,text:id===1?'私称，你来看这事':'样本'+id,at:100_000+id*100_000,
  intent:id===1?'address':id%2?'engage':'other',scene:id===1?'address':id%2?'banter':'other',
  ...(id===1?{alias:'私称',relationshipAlias:true}:{})}))
 const data=splitSamples(rows)
 assert.deepEqual(data.relationshipAliases,['私称'])
 assert.ok(data.train.intent.some(row=>row.label==='address'&&row.text==='伙伴,你来看这事'))
 assert.ok(data.train.intent.every(row=>!row.text.includes('私称')))
 assert.ok(data.train.intent.every(row=>row.text==='伙伴,你来看这事'||rows.some(raw=>raw.text===row.text)))
})

test('merged candidate context stays within the original group',()=>{
 const at=Date.now()
 const selected=chooseCandidates([
  {id:'a',sender:'u',text:'第一群前文',at,recipient:'unknown',room:'A'},
  {id:'b',sender:'v',text:'第二群前文',at:at+100,recipient:'unknown',room:'B'},
  {id:'c',sender:'u',text:'第一群后续',at:at+200,recipient:'unknown',room:'A'},
 ],at-1000)
 assert.deepEqual(selected[2].context.map(item=>item.text),['第一群前文'])
})

test('prioritizes grounded persona candidates without treating private names as public',()=>{
 const at=Date.now()-1_000_000
 const history=Array.from({length:256},(_,id)=>({id:String(id),sender:'60000',
  text:'旁白'+id,at:at+id*1000,recipient:'unknown'}))
 history[1].text='小泡，到这里来'
 history[5].text='私称，来看看'
 history[5].sender='70000'
 history[13].text='私称，其他人随口提'
 const selected=chooseCandidates(history,at,['70000'],
  {name:'伙伴',role:'外号叫小泡',relationshipText:'对方私下喊我私称'})
 assert.equal(selected.length,64)
 assert.ok(selected.some(row=>row.id===1))
 assert.ok(selected.some(row=>row.id===5))
 assert.ok(!selected.some(row=>row.id===13))
})

test('role evaluation marks real calls and mentions separately after the chronological split',()=>{
 const rows=Array.from({length:52},(_,id)=>({id,text:'样本'+id,at:100_000+id*100_000,
  intent:id%2?'engage':'other',scene:id%2?'banter':'other'}))
 for(const id of [1,42])Object.assign(rows[id],{text:'小泡，你看看'+id,intent:'address',scene:'address',alias:'小泡'})
 Object.assign(rows[43],{text:'小泡是我的朋友',intent:'other',scene:'other'})
 Object.assign(rows[44],{text:'机关盒怎么打开',intent:'engage',scene:'question',personaScene:true})
 const samples=splitSamples(rows)
 assert.deepEqual(samples.train.intent.filter(row=>row.persona),[{text:'小泡，你看看1',label:'address',persona:true}])
 assert.deepEqual(samples.holdout.intent.filter(row=>row.persona).map(row=>row.label),['address','other'])
 assert.deepEqual(samples.holdout.scene.filter(row=>row.personaScene),[{text:'机关盒怎么打开',label:'question',personaScene:true}])
})

test('annotates a grounded role scenario and limits relationship scenario cues to the verified speaker',async()=>{
 const at=Date.now()-1000
 const candidates=chooseCandidates([
  {id:'a',sender:'60000',text:'机关盒卡住啦',at,recipient:'partner'},
  {id:'b',sender:'60000',text:'分享一张窗边的晚霞',at:at+1,recipient:'unknown'},
  {id:'c',sender:'70000',text:'今天窗边的晚霞看见了没',at:at+2,recipient:'unknown'},
 ],at,['70000'])
 const seen=[]
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(options){
  const request=JSON.parse(options.messages[0].content[0].text)
  seen.push(request.settings)
  yield {type:'text-delta',text:JSON.stringify(request.rows.map(row=>({id:row.id,intent:'engage',
   scene:row.id===0?'question':'share',personaScene:row.id===0?0:1})))}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const companion={name:'小泡',role:'最喜欢拆解机关盒',relationshipText:'我们总在窗边一起看晚霞'}
 const rows=await labelSamples(ctx,companion,candidates,AbortSignal.timeout(1000),()=>{})
 assert.deepEqual(seen,[['最喜欢拆解机关盒'],['最喜欢拆解机关盒','我们总在窗边一起看晚霞']])
 assert.equal(rows[0].intent,'address')
 assert.equal(rows[0].scene,'question')
 assert.deepEqual(rows.map(row=>row.personaScene),[true,undefined,true])
})

test('training history follows the oldest message anchor and resolves quotes across pages',async()=>{
 const now=Math.floor(Date.now()/1000),calls=[]
 const message=(id,user_id,time,message=[])=>({message_id:id,user_id,time,group_id:'12345',message})
 const text={type:'text',data:{text:'有一件事'}}
 const anchor=message(-20,'70000',now-60,[text])
 const pages=[
  [anchor,message(-30,'70000',now-30,[{type:'reply',data:{id:-10}},text])],
  [message(-10,'60000',now-120,[text]),anchor],
 ]
 const samples=await readQqTrainingHistory(async id=>{calls.push(id);return {messages:pages.shift()}},'12345','60000',(now-100)*1000)
 assert.deepEqual(calls,[undefined,-20])
 assert.equal(samples.find(row=>row.id==='-30').recipient,'partner')
 assert.equal(samples.filter(row=>row.id==='-20').length,1)
})
