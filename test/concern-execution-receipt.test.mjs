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
