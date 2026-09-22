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
test('accepted inserted input moves progress and final reply to a new message',async()=>{
 let count=0
 const {events,transport}=fixture({create:async text=>{const id=`message-${++count}`;events.push(['create',id,text]);return id}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,10,0)
 controller.start();await until(()=>count===1)
 await controller.continueAfterInput()
 controller.update('tools');await until(()=>count===2)
 await controller.finish('new final')
 assert.deepEqual(events.filter(e=>e[0]==='edit'&&e[1]==='message-1').map(e=>e[2]),['已收到后续消息，处理进度与回复将在下方继续。'])
 assert.ok(events.some(e=>e[0]==='edit'&&e[1]==='message-2'&&e[2]==='new final'))
})
test('insertion waits for a late placeholder ID; simultaneous finish cannot edit the old reply',async()=>{
 let release,entered=false
 const {events,transport}=fixture({create:async()=>{entered=true;return new Promise(resolve=>{release=()=>resolve('old')})}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
 controller.start();await until(()=>entered)
 const rotation=controller.continueAfterInput()
 const final=controller.finish('after insertion')
 release();await rotation;await final
 assert.equal(events.filter(e=>e[0]==='edit'&&e[2]==='after insertion').length,0)
 assert.ok(events.some(e=>e[0]==='send'&&e[1]==='after insertion'))
})
test('repeated inserts and failed retirement never reuse the old message',async()=>{
 const {events,transport}=fixture({edit:async()=>{throw Error('network')}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
 controller.start();await until(()=>events.some(e=>e[0]==='create'))
 await Promise.all([controller.continueAfterInput(),controller.continueAfterInput()])
 await controller.finish('final')
 assert.ok(events.some(e=>e[0]==='send'&&e[1]==='final'))
 const length=events.length
 await controller.continueAfterInput();await wait(20)
 assert.equal(events.length,length)
})
test('steer acceptance racing final completion is fenced; rejected insertion keeps current message',async()=>{
 for(const accepted of [true,false]){
  const {events,transport}=fixture()
  const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
  controller.start();await until(()=>events.some(e=>e[0]==='create'))
  const settle=controller.prepareInput()
  const finish=controller.finish('final')
  await wait(5)
  assert.ok(!events.some(e=>e[0]==='send'||e[0]==='edit'))
  await settle(accepted);await finish
  assert.equal(events.some(e=>e[0]==='send'&&e[1]==='final'),accepted)
  assert.equal(events.some(e=>e[0]==='edit'&&e[2]==='final'),!accepted)
 }
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
  }else{assert.equal(calls.filter(c=>c[0].endsWith('/typing')).length,1);assert.equal(edit[0],'/api/v4/posts/post/patch');assert.equal(edit[3],'PUT');assert.equal(edit[2].message,'');assert.equal(edit[2].props.attachments[0].text,'**done**');assert.equal(adapter.finalDelivery,'separate')}
 }
})
test('Mattermost keeps progress in a native attachment and sends the final Markdown separately',async()=>{
 const calls=[]
 const adapter=directProgressTransport({platform:'mattermost',baseUrl:'http://test',targetId:'room'},'user',async()=>({accountId:'bot',peerId:'user'}),async(path,signal,body)=>{calls.push([path,body]);return {id:'progress'}},async text=>{calls.push(['send',text])})
 const controller=new ReplyProgressController(adapter,()=>true,new AbortController().signal,1000,0)
 controller.update({kind:'tool-start',id:'call',name:'read'});controller.start()
 await until(()=>calls.some(c=>c[0]==='/api/v4/posts'))
 const card=calls.find(c=>c[0]==='/api/v4/posts')[1]
 assert.equal(card.message,'');assert.match(card.props.attachments[0].text,/`read` · 执行中/)
 await controller.finish('## 回复\n\n- 完成')
 assert.deepEqual(calls.find(c=>c[0]==='send'),['send','## 回复\n\n- 完成'])
 assert.match(calls.find(c=>c[0].endsWith('/patch'))[1].props.attachments[0].text,/已结束/)
 assert.ok(!JSON.stringify(calls.filter(c=>c[0].endsWith('/patch'))).includes('## 回复'))
})
test('failed Mattermost card cleanup cannot lose or duplicate the final answer',async()=>{
 const {events,transport}=fixture({finalDelivery:'separate',edit:async()=>{throw Error('network')}})
 const controller=new ReplyProgressController(transport,()=>true,new AbortController().signal,1000,0)
 controller.start();await until(()=>events.some(e=>e[0]==='create'))
 await controller.finish('answer')
 assert.equal(events.filter(e=>e[0]==='send'&&e[1]==='answer').length,1)
})
test('progress events never expose model/tool data and observer failures are isolated',()=>{
 assert.equal(replyStage({type:'tool/call',data:{name:'secret',arguments:'password'}}),'tools')
 assert.equal(replyStage({type:'request/header'}),'composing')
 assert.equal(replyStage({type:'assistant/message',data:{secret:'reasoning'}}),undefined)
 assert.doesNotThrow(()=>reportProgress(()=>{throw Error('observer')},'tools'))
})
