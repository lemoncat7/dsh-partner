import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy} from '../lib/channels/qq/autonomy.js'

const companion={name:'小明'}
const signal=()=>new AbortController().signal
const member='22345678',other='33445678'
const input=(id,text,userId=member,extra={})=>({id,text,sender:`group:12345678:${userId}`,
 qqGroup:{groupId:'12345678',userId,senderName:userId===member?'甲':'乙',autonomous:true,mentioned:false,...extra}})

test('generation retains successive delivered turns to the same member in the classifier’s room order',async()=>{
 let now=1_000_000,frame
 const gate=new QqGroupAutonomy({},()=>now,async(_t,_s,_c,_d,value)=>{frame=value})
 const add=(id,text,user=member)=>{now+=1000;const e=input(id,text,user);gate.observe('c',e);return e}
 const first=add('first','剪映和 PR 哪个方便')
 now+=1000;gate.replied('c',first,'自己剪用哪个顺手就用哪个')
 const second=add('second','还有设计师要一起干活')
 now+=1000;gate.replied('c',second,'那得看工程和素材能不能互用')
 add('explanation','PSD 可以作为 AE 里的图层',other)
 const current=add('current','原来是文件互通')
 const rows=JSON.parse(gate.context('c',current))
 assert.deepEqual(rows.map(r=>r.text),[
  '剪映和 PR 哪个方便','自己剪用哪个顺手就用哪个','还有设计师要一起干活',
  '那得看工程和素材能不能互用','PSD 可以作为 AE 里的图层'])
 assert.equal(new Set(rows.map(r=>r.messageId)).size,rows.length)
 const delivered=rows.filter(r=>r.kind==='partner')
 assert.deepEqual(delivered.map(r=>r.replyTo),['first','second'])
 assert.ok(delivered.every(r=>r.qqId==='partner'&&r.recipient===member&&r.replyToEvidence==='delivery'))
 await gate.shouldReply('c',current,companion,signal())
 assert.deepEqual(frame.dialogue.map(t=>t.text),rows.map(r=>r.text))
})

test('a queued input never receives a same-millisecond send that occurred after its observation',()=>{
 const now=1_000_000,gate=new QqGroupAutonomy({},()=>now)
 const first=input('first','先问一句'),queued=input('queued','我接着补充'),later=input('later','后来的话')
 gate.observe('c',first)
 gate.observe('c',queued)
 gate.replied('c',first,'排队之后才送达的回复')
 gate.observe('c',later)
 const rows=JSON.parse(gate.context('c',queued))
 assert.deepEqual(rows.map(r=>r.text),['先问一句'])
 assert.ok(JSON.parse(gate.context('c',later)).some(r=>r.text==='排队之后才送达的回复'))
})

test('a semantic link remains a per-input candidate instead of a fact in subsequent transcripts or classifier frames',async()=>{
 let now=1_000_000,frame
 const gate=new QqGroupAutonomy({},()=>now,async(text,_s,_c,_d,value)=>{
  frame=value
  const index=value.dialogue.findIndex(t=>t.text==='那我画的小人也能动吗')
  return text==='应该没这么夸张'&&index>=0
   ?{label:'engage',confidence:.8,margin:.6,link:{index,confidence:.9,margin:.7}}
   :undefined
 })
 const add=(id,text,user=member)=>{now+=1000;const e=input(id,text,user);gate.observe('c',e);return e}
 const origin=add('psd','PSD 可以作为 AE 图层',other)
 now+=1000;gate.replied('c',origin,'那我画的小人也能动吗')
 add('ecosystem','或者说就是苹果生态和安卓生态的区别',other)
 const ambiguous=add('ambiguous','应该没这么夸张')
 assert.equal(await gate.shouldReply('c',ambiguous,companion,signal()),true,'the generation model can still judge an admitted candidate')
 assert.equal(gate.status('c').linkedMessageId,'reply:psd')
 const guidance=gate.guidance('c',ambiguous)
 assert.match(guidance,/本地推测的关联候选/)
 assert.doesNotMatch(guidance,/当前发言承接你已经送达的回复/)
 // Redelivery must not preserve or promote the earlier guess either.
 gate.observe('c',ambiguous)
 const next=add('next','差不多吧',other)
 const rows=JSON.parse(gate.context('c',next))
 const previous=rows.find(r=>r.messageId==='ambiguous')
 assert.equal(previous.replyTo,undefined)
 assert.equal(previous.replyToEvidence,undefined)
 assert.equal(previous.recipient,undefined)
 assert.ok(rows.some(r=>r.text==='或者说就是苹果生态和安卓生态的区别'))
 await gate.shouldReply('c',next,companion,signal())
 assert.equal(frame.dialogue.find(t=>t.text==='应该没这么夸张').replyTo,undefined)
 assert.equal(frame.partnerText,'','intervening human exchanges retire the special anchor to our older joke')
})

test('transport-verified quotes retain their target in generation and numeric classifier history',async()=>{
 let now=1_000_000,frame,calls=0
 const gate=new QqGroupAutonomy({},()=>now,async(_t,_s,_c,_d,value)=>{calls++;frame=value})
 const original=input('qq:12345678:33445678:123','这几个软件的文件能互用',other)
 gate.observe('c',original)
 now+=1000
 const quote={...input('quoted','哪些文件',member,{hasReply:true}),qqReplyId:'123',
  qqQuote:{id:'123',senderId:other,text:'这几个软件的文件能互用',media:[]}}
 quote.qqGroup.replyTo='other'
 gate.observe('c',quote)
 assert.equal(await gate.shouldReply('c',quote,companion,signal()),false)
 assert.equal(calls,0,'explicit other-person quotes do not need semantic guessing')
 now+=1000
 const next=input('next','大家怎么看')
 gate.observe('c',next)
 const rows=JSON.parse(gate.context('c',next)),quoted=rows.find(r=>r.messageId==='quoted')
 assert.equal(quoted.replyTo,original.id)
 assert.equal(quoted.replyToEvidence,'quote')
 assert.equal(quoted.recipient,other)
 // Use a non-public invitation so the classifier receives the existing history.
 const check=input('check','接着聊文件互通')
 now+=1000;gate.observe('c',check)
 await gate.shouldReply('c',check,companion,signal())
 const turn=frame.dialogue.find(t=>t.text==='哪些文件')
 assert.equal(frame.dialogue[turn.replyTo].text,original.text)
 assert.doesNotMatch(JSON.stringify(frame.dialogue),/22345678|33445678/)
})

test('classifier snippets preserve the newest human explanation instead of ending on an older partner joke',async()=>{
 let now=1_000_000,frame,history
 const gate=new QqGroupAutonomy({},()=>now,async(_t,_s,rows,_d,value)=>{history=rows;frame=value})
 const start=input('start','PSD 能作为图层',other)
 gate.observe('c',start)
 now+=1000;gate.replied('c',start,'那我画的小人也能动吗')
 now+=1000;gate.observe('c',input('explanation','或者换句话说就是苹果生态和安卓生态的区别',other))
 now+=1000
 const current=input('current','应该没这么夸张')
 gate.observe('c',current)
 await gate.shouldReply('c',current,companion,signal())
 assert.deepEqual(history,['PSD 能作为图层','那我画的小人也能动吗','或者换句话说就是苹果生态和安卓生态的区别'])
 assert.equal(frame.partnerText,'')
 assert.equal(frame.dialogue.at(-1).text,history.at(-1))
})

test('a real quote of the partner is identified separately from a semantic continuation',async()=>{
 const gate=new QqGroupAutonomy({},()=>1_000_000,async()=>assert.fail('a confirmed quote bypasses inference'))
 const quote=input('quote','你刚刚说的图层呢',member,{replyTo:'self',hasReply:true})
 gate.observe('c',quote)
 assert.equal(await gate.shouldReply('c',quote,companion,signal()),true)
 assert.match(gate.guidance('c',quote),/渠道已核实当前发言引用了你的消息/)
 assert.doesNotMatch(gate.guidance('c',quote),/本地识别认为当前发言可能承接/)
})
