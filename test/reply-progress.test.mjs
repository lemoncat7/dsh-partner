import test from 'node:test'
import assert from 'node:assert/strict'
import {ReplyProgressController} from '../lib/channels/reply-progress-controller.js'
import {directProgressTransport} from '../lib/channels/direct/progress-transport.js'
import {replyStage,reportProgress} from '../lib/execution/reply-progress.js'

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await wait(5)}assert.fail('condition timeout')}
function fixture(overrides={}){
 const events=[]
 const transport={typing:async active=>{events.push(['typing',active])},create:async text=>{events.push(['create',text]);return 'message'},edit:async(id,text)=>{events.push(['edit',id,text])},send:async text=>{events.push(['send',text])},...overrides}
 return {events,transport}
}
test('progress creates one message and replaces it with final reply; no late edits',async()=>{
 const {events,transport}=fixture(),controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,10,0)
 controller.update('tools');controller.start()
 await until(()=>events.some(e=>e[0]==='create'))
 await controller.finish('**最终回复**')
 const length=events.length;await wait(30)
 assert.equal(events.length,length)
 assert.equal(events.filter(e=>e[0]==='create').length,1)
 assert.ok(events.some(e=>e[0]==='create'&&e[1]==='正在执行工具…'))
 assert.deepEqual(events.at(-2),['edit','message','**最终回复**'])
 assert.deepEqual(events.at(-1),['typing',false])
})
test('fast replies do not create placeholder posts',async()=>{
 const {events,transport}=fixture(),controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,1000)
 controller.start();await controller.finish('done')
 assert.equal(events.filter(e=>e[0]==='create').length,0)
 assert.ok(events.some(e=>e[0]==='send'&&e[1]==='done'))
})
test('a late placeholder acknowledgement is settled before the final edit',async()=>{
 let release,entered=false
 const {events,transport}=fixture({create:async()=>{entered=true;return new Promise(resolve=>{release=()=>resolve('late')})}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
 controller.start();await until(()=>entered)
 const finishing=controller.finish('final');release();await finishing
 assert.deepEqual(events.at(-2),['edit','late','final'])
 await wait(20);assert.equal(events.filter(e=>e[0]==='edit').length,1)
})
test('abort cleans up an existing progress post and stops its timer',async()=>{
 const {events,transport}=fixture(),aborter=new AbortController()
 const controller=new ReplyProgressController(transport,()=>true,aborter.signal,10,0)
 controller.start();await until(()=>events.some(e=>e[0]==='create'));aborter.abort()
 await until(()=>events.some(e=>e[0]==='typing'&&e[1]===false))
 const length=events.length;await wait(30);assert.equal(events.length,length)
 assert.match(events.find(e=>e[0]==='edit')[2],/中断/)
})
test('failed progress creation is not retried and final response remains available',async()=>{
 let creates=0;const {events,transport}=fixture({create:async()=>{creates++;throw Error('network')}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,10,0)
 controller.start();await until(()=>creates>0);await wait(30);await controller.finish('done')
 assert.equal(creates,1);assert.ok(events.some(e=>e[0]==='send'))
})
test('unsupported edit falls back, ambiguous network errors do not duplicate final replies',async()=>{
 for(const error of [Object.assign(Error('unsupported'),{status:405}),Error('network')]){
  const {events,transport}=fixture({edit:async()=>{throw error}})
  const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
  controller.start();await until(()=>events.some(e=>e[0]==='create'))
  if(error.status)await controller.finish('done');else await assert.rejects(controller.finish('done'))
  assert.equal(events.some(e=>e[0]==='send'),Boolean(error.status))
  assert.deepEqual(events.at(-1),['typing',false])
 }
})
test('revoked permission suppresses further text; failure closes progress',async()=>{
 let allowed=true;const {events,transport}=fixture()
 const controller=new ReplyProgressController(transport,()=>allowed,new AbortController().signal,1000,0)
 controller.start();await until(()=>events.some(e=>e[0]==='create'));allowed=false
 await assert.rejects(controller.finish('secret'),/授权/)
 assert.equal(events.some(e=>e[0]==='edit'||e[0]==='send'),false)
 const second=fixture(),other=new ReplyProgressController(second.transport,()=>true,new AbortController().signal,1000,0)
 other.start();await until(()=>second.events.some(e=>e[0]==='create'));await other.fail()
 assert.match(second.events.find(e=>e[0]==='edit')[2],/中断/)
})
test('protocol adapters use Matrix replacements and Mattermost post patches',async()=>{
 for(const platform of ['matrix','mattermost']){
  const calls=[]
  const adapter=directProgressTransport({platform,baseUrl:'http://test',targetId:'room'},'user',async()=>({accountId:'bot',peerId:'user'}),async(...args)=>{calls.push(args);return {event_id:'event',id:'post'}},async()=>{})
  const signal=new AbortController().signal
  await adapter.typing(true,signal);await adapter.typing(false,signal)
  const id=await adapter.create('working',signal);await adapter.edit(id,'**done**',signal)
  const edit=calls.at(-1)
  if(platform==='matrix'){
   assert.equal(calls[0][2].timeout,30000);assert.equal(calls[1][2].typing,false)
   assert.deepEqual(edit[2]['m.relates_to'],{rel_type:'m.replace',event_id:'event'})
   assert.match(edit[2]['m.new_content'].formatted_body,/<strong>done<\/strong>/)
  }else{assert.equal(calls.filter(c=>c[0].endsWith('/typing')).length,1);assert.equal(edit[0],'/api/v4/posts/post/patch');assert.equal(edit[3],'PUT');assert.equal(edit[2].message,'**done**')}
 }
})
test('progress events never expose model/tool data and observer failures are isolated',()=>{
 assert.equal(replyStage({type:'tool/call',data:{name:'secret',arguments:'password'}}),'tools')
 assert.equal(replyStage({type:'request/header'}),'composing')
 assert.equal(replyStage({type:'assistant/message',data:{secret:'reasoning'}}),undefined)
 assert.doesNotThrow(()=>reportProgress(()=>{throw Error('observer')},'tools'))
})
