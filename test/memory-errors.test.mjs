import test from 'node:test'
import assert from 'node:assert/strict'
import {memoryFinishError} from '../lib/memory-errors.js'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {MemoryJobFeedback} from '../lib/ui/memory/job-feedback.js'

test('memory diagnostics retain provider code/status without copying bodies or credentials',()=>{
 const result=memoryFinishError({kind:'error',failure:{code:'RATE_LIMIT',status:429,message:'busy https://secret.example/?key=private\nAuthorization: Bearer hidden-value',response:'private body'}})
 assert.match(result,/RATE_LIMIT.*HTTP 429/)
 assert.doesNotMatch(result,/secret.example|hidden-value|private body/)
 assert.match(memoryFinishError({kind:'max-tokens'}),/长度上限/)
 assert.match(memoryFinishError({kind:'aborted'}),/调用取消/)
 assert.match(memoryFinishError({kind:'error'}),/未提供详细原因/)
})

test('prior failure is explicitly historical while processing',()=>{
 const running=renderToStaticMarkup(createElement(MemoryJobFeedback,{status:'processing',error:'HTTP 503'}))
 assert.match(running,/上次失败/);assert.match(running,/本轮尚未结束/)
 const waiting=renderToStaticMarkup(createElement(MemoryJobFeedback,{status:'retrying',error:'HTTP 503'}))
 assert.match(waiting,/上次失败/);assert.doesNotMatch(waiting,/当前正在重试/)
 assert.equal(renderToStaticMarkup(createElement(MemoryJobFeedback,{status:'processing'})),'')
})
