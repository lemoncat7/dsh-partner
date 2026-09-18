import test from 'node:test'
import assert from 'node:assert/strict'
import {matrixTimeline} from '../lib/channels/direct/matrix-timeline.js'
import {pollDiscovered} from '../lib/channels/direct/discovery.js'
import {DirectTransport,ChannelHttpError} from '../lib/channels/direct/transport.js'
import {matrixTransientFailure} from '../lib/channels/direct/retry-policy.js'
import {DirectDispatcher} from '../lib/channels/direct/dispatcher.js'

const signal=()=>new AbortController().signal
const event=id=>({event_id:id,type:'m.room.message',sender:'peer',content:{msgtype:'m.text',body:id}})
test('gap recovery pages forward within the old/new sync boundaries and deduplicates overlap',async()=>{
  const calls=[]
  const result=await matrixTimeline('!room:test',{limited:true,events:[event('b'),event('c')]},'old','new',async path=>{
    const url=new URL(path,'http://test');calls.push(url)
    return calls.length===1?{chunk:[event('a')],end:'page2'}:{chunk:[event('b'),event('c')],end:'new'}
  },signal())
  assert.deepEqual(result.map(e=>e.event_id),['a','b','c'])
  assert.equal(calls[0].searchParams.get('from'),'old')
  assert.equal(calls[1].searchParams.get('from'),'page2')
  assert.ok(calls.every(u=>u.searchParams.get('to')==='new'&&u.searchParams.get('dir')==='f'))
  assert.match(calls[0].pathname,/%21room|!room/)
})
test('initial sync never backfills history; normal sync does not paginate',async()=>{
  const request=()=>assert.fail('unnecessary pagination')
  assert.deepEqual(await matrixTimeline('r',{limited:true,events:[event('old')]},undefined,'new',request,signal()),[])
  assert.deepEqual(await matrixTimeline('r',{events:[event('new')]},'old','new',request,signal()),[event('new')])
})
test('empty intermediate pages with advancing tokens are not mistaken for the end',async()=>{
  let calls=0
  const result=await matrixTimeline('r',{limited:true,events:[]},'old','new',async()=>++calls===1?{chunk:[],end:'middle'}:{chunk:[event('a')]},signal())
  assert.equal(calls,2);assert.equal(result[0].event_id,'a')
})
for(const kind of ['stuck','cycle','malformed','missing-id','failed-page'])test('gap failure retains caller watermark: '+kind,async()=>{
  let calls=0
  await assert.rejects(matrixTimeline('r',{limited:true,events:[event('live')]},'old','new',async()=>{
    calls++
    if(kind==='failed-page') {if(calls>1)throw Error('network');return {chunk:[event('a')],end:'p'}}
    if(kind==='stuck')return {chunk:[],end:'old'}
    if(kind==='cycle')return {chunk:[],end:calls===1?'p':'old'}
    if(kind==='missing-id')return {chunk:[{}]}
    return {}
  },signal()))
})
test('aborted pagination cannot return a successful batch',async()=>{
  const controller=new AbortController()
  await assert.rejects(matrixTimeline('r',{limited:true,events:[]},'old','new',async()=>{
    controller.abort();return {chunk:[event('a')],end:'new'}
  },controller.signal),{name:'AbortError'})
})
test('discovery recovers limited empty timeline and revalidates the room',async()=>{
  let validations=0
  const batch=await pollDiscovered('matrix','bot','old',signal(),async path=>{
    if(path.includes('/messages?'))return {chunk:[event('a')],end:'new'}
    return {next_batch:'new',rooms:{join:{room:{timeline:{limited:true,events:[]}}}}}
  },()=>({validate:async()=>{validations++;return {accountId:'bot',peerId:'peer'}}}))
  assert.equal(validations,2)
  assert.equal(batch.cursor,'new')
  assert.deepEqual(batch.messages.map(m=>[m.id,m.targetId]),[['a','room']])
})
test('pinned rooms use the same recovery path and reject changed peers',async()=>{
  for(const changed of [false,true]) {
    const api=new DirectTransport({platform:'matrix',baseUrl:'http://test',targetId:'room'},'test')
    let validations=0
    api.request=async path=>{
      if(path.includes('whoami'))return {user_id:'bot'}
      if(path.endsWith('/state')){validations++;return ['bot',changed&&validations>1?'other':'peer'].map(id=>({type:'m.room.member',state_key:id,content:{membership:'join'}}))}
      if(path.includes('/messages?'))return {chunk:[event('a')],end:'new'}
      return {next_batch:'new',rooms:{join:{room:{timeline:{limited:true,events:[event('b')]}}}}}
    }
    if(changed)await assert.rejects(api.poll('old',signal()),/成员已变化/)
    else assert.deepEqual((await api.poll('old',signal())).messages.map(m=>m.id),['a','b'])
  }
})
test('transient retry excludes auth, invalid tokens, and delivery/validation failures',()=>{
  for(const error of [new TypeError('fetch failed'),new DOMException('timeout','TimeoutError'),new ChannelHttpError(429),new ChannelHttpError(503)])assert.equal(matrixTransientFailure(error),true)
  for(const error of [new ChannelHttpError(401),new ChannelHttpError(403),new ChannelHttpError(400),Error('invalid room'),Error('delivery failed')])assert.equal(matrixTransientFailure(error),false)
})
test('backfilled bursts wait for capacity rather than failing at 100 jobs',async()=>{
  let release
  const gate=new Promise(r=>release=r),controller=new AbortController(),dispatcher=new DirectDispatcher(controller.signal,e=>assert.fail(e))
  for(let i=0;i<100;i++)dispatcher.enqueue([String(i)],'queue',async ready=>{ready();await gate})
  let available=false
  const wait=dispatcher.waitForCapacity().then(()=>{available=true})
  await new Promise(r=>setImmediate(r));assert.equal(available,false)
  release();await wait;assert.equal(available,true)
  dispatcher.enqueue(['last'],'queue',async ready=>ready())
  await dispatcher.drain()
})
