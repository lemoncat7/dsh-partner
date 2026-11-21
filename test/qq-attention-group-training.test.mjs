import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as wait} from 'node:timers/promises'
import {extractAttentionProfile} from '../lib/channels/qq/attention-profile-training.js'
import {chooseCandidates,editedLabels,labelSamples,splitSamples} from '../lib/channels/qq/attention-samples.js'
import {GroupAttentionTraining,qqHistorySamples,readQqTrainingHistory} from '../lib/channels/qq/attention-group-training.js'

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
  {message_id:5,group_id:'12345',user_id:'70000',message:[{type:'at',data:{qq:'80000'}},text]},
  {message_id:6,group_id:'12345',user_id:'70000',message:[text,{type:'at',data:{qq:'80000'}}]},
 ].map(row=>({...row,time:Math.floor(Date.now()/1000)}))
 assert.deepEqual(qqHistorySamples({messages:rows},'12345','60000').map(row=>[row.id,row.recipient]),
  [['2','partner'],['4','unknown'],['5','member'],['6','unknown']])
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
 const rows=await labelSamples(ctx,{name:'伙伴',role:'外号叫小泡',relationshipText:'对方私下喊我私称',characterCard:{enabled:true,roleText:''}},candidates,AbortSignal.timeout(1000),()=>{})
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

test('sample selection balances learned calls and non-calls across the history without an account restriction',()=>{
 const at=Date.now()-1_000_000
 const history=Array.from({length:256},(_,id)=>({id:String(id),sender:'60000',
  text:'旁白'+id,at:at+id*1000,recipient:'unknown'}))
 history[1].text='小泡，到这里来'
 history[5].text='私称，你来看看'
 history[5].sender='70000'
 history[9].text='我认识一个朋友也叫私称'
 history[13].text='私称，你来吗'
 const companion={name:'伙伴',role:'外号叫小泡',relationshipText:'对方私下喊我私称',characterCard:{enabled:true,roleText:''}}
 const before=chooseCandidates(history,at,['70000'],companion)
 const selected=chooseCandidates(history,at,['70000'],companion,{role:['小泡'],relationship:['私称']})
 assert.equal(selected.length,64)
 assert.ok(!before.some(row=>row.id===13))
 assert.ok([1,5,9,13].every(id=>selected.some(row=>row.id===id)))
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
 const companion={name:'小泡',role:'最喜欢拆解机关盒',relationshipText:'我们总在窗边一起看晚霞',characterCard:{enabled:true,roleText:''}}
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
  [anchor,message(-30,'70000',now-30,[{type:'reply',data:{id:-10}},{type:'text',data:{text:'那我晚点去确认'}}])],
  [message(-10,'60000',now-160,[text]),anchor],
 ]
 const samples=await readQqTrainingHistory(async id=>{calls.push(id);return {messages:pages.shift()}},'12345','60000',(now-100)*1000)
 assert.deepEqual(calls,[undefined,-20])
 assert.equal(samples.find(row=>row.id==='-30').recipient,'partner')
 assert.equal(samples.filter(row=>row.id==='-20').length,1)
 const prompts=chooseCandidates(samples,(now-170)*1000)
 const current=prompts.find(row=>row.recipient==='partner')
 assert.equal(prompts.length,2)
 assert.ok(current.context.some(turn=>turn.speaker===-1&&turn.text==='有一件事'))
})

test('natural role and relationship wording provides name evidence without keywords',async()=>{
 const at=Date.now()
 const companion={name:'小舟',role:'整理机械零件',characterCard:{enabled:true,roleText:'我是海边小铺的阿榆。'},
  relationshipText:'我是你的搭档，咱俩一起做木工。'}
 const candidates=chooseCandidates([
  {id:'a',sender:'50000',text:'阿榆，过来一下',at,recipient:'unknown'},
  {id:'b',sender:'50001',text:'搭档，你来看看这个',at:at+1,recipient:'unknown'},
  {id:'c',sender:'50002',text:'搭档，你也看看',at:at+2,recipient:'unknown'},
  {id:'d',sender:'50001',text:'搭档，你说呢',at:at+3,recipient:'member'},
 ],at,['50001'],companion)
 const inputs=[]
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(options){
  const payload=JSON.parse(options.messages[0].content[0].text)
  inputs.push(payload)
  yield {type:'text-delta',text:JSON.stringify(payload.rows.map(row=>({id:row.id,intent:'address',scene:'address',alias:row.text.split('，')[0]})))}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const labels=await labelSamples(ctx,companion,candidates,AbortSignal.timeout(1000),()=>{})
 const get=id=>labels.find(row=>row.id===id)
 assert.deepEqual(inputs[0].roleNames,['我是海边小铺的阿榆'])
 assert.equal(inputs[0].relationshipNames,undefined)
 assert.ok(!JSON.stringify(inputs[0]).includes('一起做木工'))
 assert.deepEqual(inputs[1].relationshipNames,['我是你的搭档，咱俩一起做木工'])
 assert.equal(get(0).alias,'阿榆')
 assert.equal(get(1).alias,'搭档')
 assert.equal(get(1).relationshipAlias,true)
 assert.equal(get(2).alias,undefined)
 assert.equal(get(3).intent,'other')
 assert.equal(get(3).scene,'other')
 assert.equal(get(3).alias,undefined)
})

test('a legacy role card contributes its active identity; a disabled relationship is excluded',async()=>{
 const at=Date.now()
 const companion={name:'小舟',characterCard:{enabled:true,identity:'我是海边小铺的阿榆',examples:[]},relationshipText:'我是你的搭档'}
 const input=chooseCandidates([{id:'a',sender:'50001',text:'阿榆，你在吗',at,recipient:'partner'}],at,[],companion)
 let payload
 const ctx={get:()=>({currentSelection:()=>({provider:'p',model:'m'})}),llm:{async *stream(options){
  payload=JSON.parse(options.messages[0].content[0].text)
  yield {type:'text-delta',text:'[{"id":0,"intent":"address","scene":"address","alias":"阿榆"}]'}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const result=await labelSamples(ctx,companion,input,AbortSignal.timeout(1000),()=>{})
 assert.equal(result[0].alias,'阿榆')
 const disabled={...companion,characterCard:{...companion.characterCard,enabled:false}}
 await labelSamples(ctx,disabled,chooseCandidates([{id:'b',sender:'50001',text:'搭档，你在吗',at,recipient:'partner'}],at,['50001'],disabled),AbortSignal.timeout(1000),()=>{})
 assert.equal(payload.relationshipNames,undefined)
 assert.ok(!payload.settings.includes(disabled.relationshipText))
})

const profileFixture={
 name:'小舟',role:'整理资料',characterCard:{enabled:true,roleText:'我是档案馆的阿榆。喜欢修理旧收音机'},
 relationshipText:'我是你的搭档。我们常常一起做木工'
}
const profileResponse={
 role:{aliases:[{alias:'阿榆',evidence:'我是档案馆的阿榆'},{alias:'搭档',evidence:'我是你的搭档'}],
  scenes:['喜欢修理旧收音机','我们常常一起做木工']},
 relationship:{aliases:[{alias:'搭档',evidence:'我是你的搭档'}],scenes:['我们常常一起做木工']}
}
function profileContext(){
 return {get:()=>({currentSelection:()=>({provider:'p',model:'m',reasoningEffort:'high'})}),llm:{
  async *stream(options){
  assert.equal(options.reasoningEffort,'high')
  assert.equal(options.maxTokens,undefined)
  const input=JSON.parse(options.messages[0].content[0].text)
  yield {type:'text-delta',text:JSON.stringify(input.rows?input.rows.map(row=>{
   const call=row.text.startsWith('搭档，你')
   return {id:row.id,intent:call?'address':row.id%2?'engage':'other',scene:call?'address':row.id%2?'question':'other'}
  }):profileResponse)}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
}
test('setting extraction grounds public and relationship cues in their own sources',async()=>{
 const profile=await extractAttentionProfile(profileContext(),profileFixture,AbortSignal.timeout(1000))
 assert.deepEqual(profile.role.aliases,['小舟','阿榆'])
 assert.deepEqual(profile.role.scenes,['喜欢修理旧收音机'])
 assert.deepEqual(profile.relationship.aliases,['搭档'])
 assert.deepEqual(profile.relationship.scenes,['我们常常一起做木工'])
 const disabled={...profileFixture,characterCard:{enabled:false}}
 const inactive=await extractAttentionProfile(profileContext(),disabled,AbortSignal.timeout(1000))
 assert.deepEqual(inactive.relationship.aliases,[])
 assert.deepEqual(inactive.relationship.scenes,[])
 assert.notEqual(inactive.role.revision,profile.role.revision)
})

test('multiple rooms use their own model and reasoning for history labels with no plugin token cap',async()=>{
 const calls=[]
 const ctx={llm:{async *stream(options){
  const {rows}=JSON.parse(options.messages[0].content[0].text)
  calls.push([options.provider,options.model,options.reasoningEffort,options.maxTokens,rows.map(row=>row.id)])
  yield {type:'text-delta',text:JSON.stringify(rows.map(row=>({id:row.id,intent:'engage',scene:'question'})))}
  yield {type:'finish',reason:{kind:'stop'}}
 }}}
 const input=['first','second'].map((room,id)=>({room,id,text:'场景样本 '+id,at:id,recipient:'unknown',bound:false,context:[]}))
 const models=new Map([['first',{provider:'one',model:'m1',reasoningEffort:'high'}],['second',{provider:'two',model:'m2'}]])
 const result=await labelSamples(ctx,profileFixture,input,AbortSignal.timeout(1000),()=>{},models)
 assert.deepEqual(calls,[['one','m1','high',undefined,[0]],['two','m2',undefined,undefined,[1]]])
 assert.equal(result.length,2)
})

test('one-click learns settings before history and retains them when there are no group samples',async t=>{
 const events=[]
 const attention={
  trainProfile:async(_scopes,cues)=>{events.push('settings');assert.deepEqual(cues.relationship.aliases,['搭档'])},
  trainGroups:async()=>assert.fail('empty history must not train a classifier'),
  groupStatus:()=>({versions:[]})
 }
 const service=new GroupAttentionTraining(profileContext(),'/unused',attention)
 t.after(()=>service.close())
 const target={scope:'g',companion:profileFixture,boundIds:[],guard(){},async history(){events.push('history');return []}}
 await service.batchAction('q',[target],{action:'train',days:3,confirm:true})
 while(service.batchView('q',[target]).busy)await wait(5)
 const {job}=service.batchView('q',[target])
 assert.deepEqual(events,['settings','history'])
 assert.equal(job.phase,'done')
 assert.equal(job.history,'skipped')
 assert.equal(job.profile.relationshipAliases,1)
 assert.equal(job.samples,0)
})

test('zero selected groups trains the companion defaults without a history range or a group head',async t=>{
 const events=[]
 const attention={
  trainDefault:async(scope,cues,guard)=>{
   assert.equal(scope,'default:partner')
   assert.deepEqual(cues.relationship.aliases,['搭档'])
   guard()
   events.push('default')
  },
  trainProfile:async()=>assert.fail('no group profile should be written'),
  trainGroups:async()=>assert.fail('no group head should be trained'),
  groupStatus:()=>({versions:[]}),
 }
 const service=new GroupAttentionTraining(profileContext(),'/unused',attention)
 t.after(()=>service.close())
 const target={scope:'default:partner',companion:profileFixture,guard(){}}
 await service.batchAction('q',[],{action:'train',confirm:true},target)
 while(service.batchView('q',[],target.scope).busy)await wait(5)
 const {job}=service.batchView('q',[],target.scope)
 assert.deepEqual(events,['default'])
 assert.equal(job.phase,'done')
 assert.equal(job.groups,0)
 assert.equal(job.history,undefined)
 assert.equal(job.profile.relationshipAliases,1)
})

test('one-click history learns calls by other members and retains the settings if evaluation fails',async t=>{
 const events=[]
 const attention={
  trainProfile:async()=>{events.push('settings')},
  trainGroups:async(_scopes,samples)=>{
   events.push('classifier')
   assert.deepEqual(samples.train.intent.filter(row=>row.persona),[{text:'伙伴,你看一下收音机',label:'address',persona:true}])
   assert.deepEqual(samples.holdout.intent.filter(row=>row.persona),[
    {text:'伙伴,你会换旋钮吗',label:'address',persona:true},
    {text:'我家搭档也有收音机',label:'other',persona:true},
   ])
   throw Error('历史留出评估未通过')
  },
  groupStatus:()=>({versions:[]})
 }
 const ctx=profileContext()
 const stream=ctx.llm.stream
 ctx.llm.stream=function(options){
  const input=JSON.parse(options.messages[0].content[0].text)
  if(input.rows){
   assert.deepEqual(input.aliases,['小舟','阿榆','搭档'])
   assert.equal(input.relationshipNames,undefined)
   assert.ok(!JSON.stringify(input).includes('一起做木工'))
  }
  return stream(options)
 }
 const service=new GroupAttentionTraining(ctx,'/unused',attention)
 t.after(()=>service.close())
 const at=Date.now()-7200000
 const target={scope:'g',companion:profileFixture,boundIds:[],guard(){},async history(){
  events.push('history')
  const examples={1:'搭档，你看一下收音机',42:'搭档，你会换旋钮吗',44:'我家搭档也有收音机'}
  return Array.from({length:52},(_,id)=>({id:String(id),sender:'50000',text:examples[id]??'群聊样本 '+id,at:at+id*100000,recipient:'unknown'}))
 }}
 await service.batchAction('q',[target],{action:'train',days:3,confirm:true})
 while(service.batchView('q',[target]).busy)await wait(5)
 const {job}=service.batchView('q',[target])
 assert.deepEqual(events,['settings','history','classifier'])
 assert.equal(job.phase,'done')
 assert.equal(job.history,'rejected')
 assert.match(job.warning,/留出评估/)
 assert.equal(job.profile.roleScenes,1)
 assert.equal(job.personaSamples,1)
 assert.deepEqual(job.sceneCoverage.find(row=>row.scene==='address'),{scene:'address',training:1,holdout:1})
})
