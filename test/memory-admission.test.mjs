import test from 'node:test'
import assert from 'node:assert/strict'
import {automaticMemoryAllowed} from '../lib/memory-admission.js'
const local={kind:'local',companionId:'c',sessionId:'main'}
const privateRoute={kind:'channel',companionId:'c',sessionId:'main',userId:'123',inboundMessageIds:['private']}
const group={kind:'channel',companionId:'c',sessionId:'main',userId:'group:123:456',inboundMessageIds:['group']}
const routes=[local,privateRoute,group]
const message=(id,text,kind='user')=>({type:'user/message',data:{id,source:{kind},content:[{type:'text',text}]}})
test('only main conversation learns automatically; independent conversations keep context only',()=>{
 assert.equal(automaticMemoryAllowed('main',[message('local','我习惯早上工作')],routes),true)
 assert.equal(automaticMemoryAllowed('main',[message('private','我习惯早上工作')],routes),true)
 assert.equal(automaticMemoryAllowed('other',[message('private','我习惯早上工作')],routes),false)
 assert.equal(automaticMemoryAllowed('main',[message('group','我习惯早上工作')],routes),false)
})
test('greetings, autonomous notices and old group envelopes do not enter memory backfill',()=>{
 for(const e of [message('local','谢谢！'),message('old','[QQ 群 123 · 发言人 路人（456）] 今天真热闹'),message('activity','查看空间动态','plugin:@lemoncat7/dsh-partner')])assert.equal(automaticMemoryAllowed('main',[e],routes),false)
 assert.equal(automaticMemoryAllowed('main',[message('local','记住，我不喝咖啡')],routes),true)
})
