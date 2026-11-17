import test from 'node:test'
import assert from 'node:assert/strict'
import {recoverReplyTokenLimit} from '../lib/execution/request-token-recovery.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const header=(maxTokens,adapterDefault=false)=>({type:'request/header',data:{header:{config:{provider:'p',model:'m',...(maxTokens===undefined?{}:{maxTokens})},...(adapterDefault?{adapterDefaults:{maxTokens:true}}:{})}}})
const idle={type:'user/message',data:{source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}
const user={type:'user/message',data:{source:{kind:'user'}}}
test('old autonomous 800 cap inherited by later user requests restores the prior model setting',()=>{
 const options={provider:'p',model:'m',maxTokens:800,temperature:0.3}
 const restored=recoverReplyTokenLimit(options,[header(8192),idle,header(800),user,header(800)])
 assert.deepEqual(restored,{...options,maxTokens:8192});assert.equal(options.maxTokens,800)
})
test('old continuous 700 cap restores adapter default without pinning its resolved value',()=>{
 assert.deepEqual(recoverReplyTokenLimit({provider:'p',model:'m',maxTokens:700},[header(8192,true),idle,header(700)]),{provider:'p',model:'m'})
})
test('explicit low user settings, adapter defaults and unrelated models are preserved',()=>{
 const options={provider:'p',model:'m',maxTokens:800}
 for(const events of [[header(8192),user,header(800)],[header(800)],[header(8192),idle,header(800,true)],[header(8192),idle,header(800),{...header(800),data:{header:{config:{provider:'other',model:'m',maxTokens:800}}}}]])assert.equal(recoverReplyTokenLimit(options,events),options)
})
test('ordinary model output settings remain unchanged',()=>{
 const options={provider:'p',model:'m',maxTokens:16384};assert.equal(recoverReplyTokenLimit(options,[header(8192),idle,header(800)]),options)
})
