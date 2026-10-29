import test from 'node:test'
import assert from 'node:assert/strict'
import {QqLatencyHistory,setReplyTiming,getReplyTiming} from '../lib/channels/qq/latency.js'
test('live timing history is bounded, detached and never enters persisted reply payloads',()=>{
 const h=new QqLatencyHistory()
 for(let i=0;i<22;i++){const sample=h.start('c',String(i),Date.now());sample.outcome='replied'}
 assert.equal(h.view('c').length,20);assert.equal(h.view('c')[0].messageId,'2')
 const copy=h.view('c');copy[0].outcome='failed';assert.equal(h.view('c')[0].outcome,'replied')
 const reply={text:'private',attachments:[]};setReplyTiming(reply,{stateCommitMs:99})
 assert.equal(getReplyTiming(reply).stateCommitMs,99);assert.equal(JSON.stringify(reply).includes('stateCommitMs'),false)
})
