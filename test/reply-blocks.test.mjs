import test from 'node:test'
import assert from 'node:assert/strict'
import {ReplyBlocks} from '../lib/channels/reply-blocks.js'
import {ReplyProgressController} from '../lib/channels/reply-progress-controller.js'
import {replyActivity} from '../lib/execution/reply-progress.js'

function fixture(overrides={}){
 const events=[];let next=0
 const transport={activityBlocks:true,typing:async()=>{},create:async text=>{const id=`p${++next}`;events.push(['create',id,text]);return id},edit:async(id,text)=>{events.push(['edit',id,text])},send:async text=>{events.push(['send',text])},...overrides}
 return {events,transport}
}
const start=(id,name='read')=>({kind:'tool-start',id,name})
const end=(id,failed=false)=>({kind:'tool-end',id,failed})
test('prose and tool groups retain chronological boundaries; consecutive tools share one post',async()=>{
 const f=fixture(),blocks=new ReplyBlocks(f.transport,()=>true,new AbortController().signal)
 blocks.update({kind:'text',text:'先检查配置。'})
 blocks.update(start('a'));blocks.update(start('b','grep'));blocks.update(end('a'));blocks.update(end('b',true))
 blocks.update({kind:'text',text:'再检查连接。'})
 blocks.update(start('c','http'));blocks.update(end('c'))
 await blocks.finish('## 最终结果')
 assert.deepEqual(f.events.filter(e=>e[0]==='send').map(e=>e[1]),['先检查配置。','再检查连接。','## 最终结果'])
 assert.equal(f.events.filter(e=>e[0]==='create').length,2)
 const old=f.events.findLast(e=>e[0]==='edit'&&e[1]==='p1')
 assert.match(old[2],/`read` · 完成/);assert.match(old[2],/`grep` · 失败/)
 const secondProse=f.events.findIndex(e=>e[0]==='send'&&e[1]==='再检查连接。')
 assert.ok(f.events.slice(secondProse).every(e=>e[0]!=='edit'||e[1]!=='p1'))
})
test('late results cannot reopen a sealed block or mark unfinished tools successful',async()=>{
 const f=fixture(),blocks=new ReplyBlocks(f.transport,()=>true,new AbortController().signal)
 blocks.update(start('old'));await blocks.boundary('下方继续')
 blocks.update(end('old'));blocks.update(start('new'));await blocks.finish('done')
 assert.match(f.events.find(e=>e[0]==='edit'&&e[1]==='p1')[2],/未确认完成/)
 assert.equal(f.events.filter(e=>e[0]==='edit'&&e[1]==='p1').length,1)
})
test('uncertain block delivery is not retried and never suppresses final reply',async()=>{
 let creates=0
 const f=fixture({create:async()=>{creates++;throw Error('timeout')}}),blocks=new ReplyBlocks(f.transport,()=>true,new AbortController().signal)
 blocks.update(start('a'));blocks.update(start('b'));await blocks.flush();await blocks.finish('final')
 assert.equal(creates,1);assert.deepEqual(f.events,[['send','final']])
})
test('steering fences block activity and final delivery until the boundary is committed',async()=>{
 const f=fixture(),controller=new ReplyProgressController(f.transport,()=>true,new AbortController().signal,1000,1000)
 controller.start();controller.update(start('a'))
 const settle=controller.prepareInput()
 controller.update({kind:'text',text:'根据补充继续。'});controller.update(start('b'))
 const finished=controller.finish('最终')
 await settle(true);await finished
 assert.equal(f.events.filter(e=>e[0]==='create').length,2)
 const prose=f.events.findIndex(e=>e[0]==='send'&&e[1]==='根据补充继续。')
 assert.ok(f.events.slice(prose).every(e=>e[0]!=='edit'||e[1]!=='p1'))
})
test('event projection excludes tool arguments/results, reasoning and final prose',()=>{
 assert.deepEqual(replyActivity({type:'tool/call',data:{callId:'a',name:'bash',arguments:'password'}}),start('a','bash'))
 assert.deepEqual(replyActivity({type:'tool/result',data:{message:{content:[{toolCallId:'a',isError:true,content:[{text:'secret'}]}]}}}),end('a',true))
 const message=content=>({type:'assistant/message',data:{message:{content}}})
 assert.equal(replyActivity(message([{type:'text',text:'final'}])),undefined)
 assert.deepEqual(replyActivity(message([{type:'reasoning',text:'private'},{type:'text',text:'说明'},{type:'tool-call'}])),{kind:'text',text:'说明'})
})
test('revocation while sealing a block suppresses the following prose and final answer',async()=>{
 let allowed=true
 const f=fixture({edit:async()=>{allowed=false}})
 const blocks=new ReplyBlocks(f.transport,()=>allowed,new AbortController().signal)
 blocks.update(start('a'));await blocks.flush()
 blocks.update(end('a'))
 blocks.update({kind:'text',text:'must not send'})
 await assert.rejects(blocks.finish('final'),/撤销/)
 assert.equal(f.events.filter(e=>e[0]==='send').length,0)
})
