import test from 'node:test'
import assert from 'node:assert/strict'
import {hasConcernReply} from '../lib/concern-execution-receipt.js'

const message=id=>({type:'user/message',data:{id}})
const answer={type:'assistant/message',data:{message:{content:[{type:'text',text:'执行结果'}]}}}
const end={type:'turn/end',data:{reason:{kind:'completed'}}}
test('direct concern receipt requires its own completed final answer, not tool chatter or later user reply',()=>{
  assert.equal(hasConcernReply([message('c'),answer,end],'c'),true)
  assert.equal(hasConcernReply([message('c'),{type:'user/message',data:{source:{kind:'runtime-context'}}},answer,end],'c'),true)
  assert.equal(hasConcernReply([message('c'),answer],'c'),false)
  assert.equal(hasConcernReply([message('c'),answer,{type:'tool/result'},end],'c'),false)
  assert.equal(hasConcernReply([message('c'),answer,{type:'turn/end',data:{reason:{kind:'cancelled'}}}],'c'),false)
  assert.equal(hasConcernReply([message('c'),message('other'),answer,end],'c'),false)
  assert.equal(hasConcernReply([message('other'),answer,end],'c'),false)
})

test('automatic compaction in a long execution is not a competing user turn',()=>{
  const checkpoint={type:'user/message',data:{id:'checkpoint',source:{kind:'compact-checkpoint',compactionId:'compact-1'},content:[{type:'text',text:'Automatically condensed prior context'}]}}
  assert.equal(hasConcernReply([message('c'),{type:'tool/result'},checkpoint,answer,end],'c'),true)
  assert.equal(hasConcernReply([message('c'),checkpoint,{type:'turn/end',data:{reason:{kind:'interrupted'}}}],'c'),false)
  assert.equal(hasConcernReply([message('c'),checkpoint,message('real-user'),answer,end],'c'),false)
  assert.equal(hasConcernReply([message('c'),checkpoint,{...answer,data:{...answer.data,interrupted:true}},end],'c'),false)
  assert.equal(hasConcernReply([message('c'),{type:'user/message',data:{id:'not-checkpoint',content:checkpoint.data.content}},answer,end],'c'),false)
})

test('time snapshots and owned attachment receipts preserve a later completed result',()=>{
 const time={type:'user/message',data:{id:'clock',source:{kind:'time-context',form:'snapshot'}}}
 const attachment={type:'user/message',data:{id:'file',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴附件交付'}}}
 assert.equal(hasConcernReply([message('c'),{type:'tool/result'},time,answer,end],'c'),true)
 assert.equal(hasConcernReply([message('c'),{type:'tool/result'},attachment,answer,end],'c'),true)
 assert.equal(hasConcernReply([message('c'),time,attachment,end],'c'),false)
 const user={...attachment,data:{...attachment.data,source:{kind:'user',summary:'伙伴附件交付'}}}
 assert.equal(hasConcernReply([message('c'),user,answer,end],'c'),false)
 const other={...attachment,data:{...attachment.data,source:{...attachment.data.source,summary:'关注变化 · 直接执行'}}}
 assert.equal(hasConcernReply([message('c'),other,answer,end],'c'),false)
})

test('recovery result is visible without turning blocked work into successful delivery',async()=>{
 const {concernReplySummary}=await import('../lib/concern-execution-receipt.js')
 const blocked={type:'assistant/message',data:{message:{content:[{type:'text',text:'草稿箱为空，原 media_id 无效。本轮未重复建稿，需要核对原稿去向。'}]}}}
 assert.equal(concernReplySummary([message('c'),blocked,end],'c'),blocked.data.message.content[0].text)
 assert.equal(concernReplySummary([message('c'),blocked,{type:'turn/end',data:{reason:{kind:'interrupted'}}}],'c'),undefined)
})

test('automatic recovery requires exact disposal and no later user or task input',async()=>{
 const {concernDisposed,concernMissingReply,ConcernInterruptedError}=await import('../lib/concern-execution-receipt.js')
 const disposed={type:'turn/end',data:{reason:{kind:'aborted',reason:{kind:'disposed'}}}}
 const log=[message('c'),{type:'tool/result'},disposed]
 assert.equal(concernDisposed(log,'c'),true)
 assert.ok(concernMissingReply(log,'c') instanceof ConcernInterruptedError)
 for(const events of [log.concat(message('later')), [message('c'),end], [message('c')], [message('c'),{type:'turn/end',data:{reason:{kind:'aborted',reason:{kind:'user'}}}}]])assert.equal(concernDisposed(events,'c'),false)
 assert.equal(concernDisposed(log.concat({type:'user/message',data:{source:{kind:'runtime-context'}}}),'c'),true)
})


test('producer-declared skill catalogs preserve final receipts and host-disposal recovery',async()=>{
 const {concernReplySummary,concernDisposed,concernMissingReply,ConcernInterruptedError}=await import('../lib/concern-execution-receipt.js')
 const disposed={type:'turn/end',data:{reason:{kind:'aborted',reason:{kind:'disposed'}}}}
 const blocked={type:'assistant/message',data:{message:{content:[{type:'text',text:'恢复入口受阻，尚未操作公众号'}]}}}
 for(const source of [{kind:'skill-catalog',form:'catalog',entries:[]},{kind:'skill-catalog',form:'catalog',entries:[],update:true},{kind:'plugin:skill-directory',form:'catalog'},{kind:'plugin:another-skill-provider',form:'catalog'}]){
  const catalog={type:'user/message',data:{id:'skills',source,content:[{type:'text',text:'Available skills'}]}}
  assert.equal(concernReplySummary([message('task'),catalog,blocked,end],'task'),'恢复入口受阻，尚未操作公众号')
  assert.equal(concernDisposed([message('task'),catalog,disposed,catalog],'task'),true)
  assert.ok(concernMissingReply([message('task'),catalog,disposed],'task') instanceof ConcernInterruptedError)
  for(const next of [message('new-user'),{type:'user/message',data:{id:'next-task',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'关注变化 · 直接执行'}}},{type:'user/message',data:{id:'unknown',source:{kind:'unknown'}}},{type:'user/message',data:{id:'invoke',source:{kind:'skill-invocation',form:'instructions',name:'publish'}}},{type:'user/message',data:{id:'user-catalog',source:{kind:'user',form:'catalog'}}}]){
   assert.equal(hasConcernReply([message('task'),catalog,next,blocked,end],'task'),false)
   assert.equal(concernDisposed([message('task'),catalog,disposed,next],'task'),false)
  }
  assert.equal(hasConcernReply([message('task'),catalog,blocked,{type:'turn/end',data:{reason:{kind:'cancelled'}}}],'task'),false)
 }
})
