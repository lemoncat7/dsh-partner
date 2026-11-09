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
