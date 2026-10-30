import test from 'node:test'
import assert from 'node:assert/strict'
import {AuthoredProgress} from '../lib/channels/authored-progress.js'
import {replyActivity} from '../lib/execution/reply-progress.js'
test('sends authored text in order before final, excludes fixed status and bounds repetition',async()=>{
 const sent=[];const progress=new AuthoredProgress(async text=>sent.push(text),()=>true,new AbortController().signal)
 progress.update('working');progress.update({kind:'tool-start',id:'a',name:'secret'})
 for(const text of ['我去看看。','我去看看。','找到线索了。','再核实一下。','第四条'])progress.update({kind:'text',text})
 await progress.finish();sent.push('最终结果')
 assert.deepEqual(sent,['我去看看。','找到线索了。','再核实一下。','最终结果'])
})
test('revocation and unknown send failure suppress pending progress without retry',async()=>{
 let allowed=true,calls=0
 const progress=new AuthoredProgress(async()=>{calls++;throw Error('unknown send')},()=>allowed,new AbortController().signal)
 progress.update({kind:'text',text:'one'});progress.update({kind:'text',text:'two'})
 await progress.finish();assert.equal(calls,1)
 const revoked=new AuthoredProgress(async()=>calls++,()=>allowed,new AbortController().signal)
 revoked.update({kind:'text',text:'revoked'});allowed=false;await revoked.finish();assert.equal(calls,1)
})
test('terminal reply text is never also forwarded as progress',()=>{
 for(const call of [{name:'partner_chat_reply',arguments:'{}'},{name:'partner_tools',arguments:'{"name":"partner_chat_reply"}'}]){
 assert.equal(replyActivity({type:'assistant/message',data:{message:{content:[{type:'text',text:'hello'},{type:'tool-call',id:'a',...call}]}}}),undefined)
 }
})
