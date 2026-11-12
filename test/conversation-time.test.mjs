import test from 'node:test'
import assert from 'node:assert/strict'
import {renderConversationTime} from '../lib/character/conversation-time.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const now=Date.parse('2026-11-12T16:30:00Z'),hour=3600000
const user=(id,time)=>({type:'user/message',time,data:{id,source:{kind:'user'},content:[]}})
const routes=[{id:'a',kind:'channel',sessionId:'s',inboundMessageIds:['a1','a2'],idleContactState:{messageId:'idle'}},{id:'b',kind:'channel',sessionId:'s',inboundMessageIds:['b1']},{id:'local',kind:'local',sessionId:'s'}]
const render=(events,zone='Asia/Shanghai')=>renderConversationTime('s',events,routes,zone,now)
test('same speaker gap crosses local midnight without using other group speakers',()=>{
 const text=render([user('a1',now-3*hour),user('b1',now-hour/2),user('a2',now)])
 assert.match(text,/11\/13.*00:30/);assert.match(text,/11\/12.*21:30/);assert.match(text,/两条消息间隔 3 小时 0 分钟/);assert.doesNotMatch(text,/23:59|30 分钟/)
})
test('autonomy uses its exact target instead of the most recent group member',()=>{
 const idle={type:'user/message',time:now,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[]}}
 const text=render([user('a1',now-3*hour),user('b1',now-hour),idle])
 assert.match(text,/活动对象最近一次消息.*3 小时/);assert.doesNotMatch(text,/1 小时/)
})
test('unknown and browser origins do not inherit channel contact times',()=>{
 const text=render([user('a1',now-3*hour),user('browser',now)])
 assert.doesNotMatch(text,/3 小时|上一条消息/)
 const idle={type:'user/message',time:now,data:{id:'unknown',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[]}}
 assert.match(render([user('a1',now-hour),idle]),/缺少可核验/)
})
test('only confirmed same-route delivery is labelled delivered; future times ignored',()=>{
 const reply=(id,time,delivered)=>({type:'tool/ptc-dispatch',time,data:{meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'嗨'}],originRouteId:id,delivered}}})
 const text=render([user('a1',now-hour),reply('a',now-600000,true),reply('b',now-300000,true),reply('a',now-120000,false),user('a2',now+hour)])
 assert.match(text,/送达确认的回复.*10 分钟/);assert.doesNotMatch(text,/两条消息间隔|距现在 -/)
 assert.doesNotThrow(()=>render([], 'bad/zone'));assert.match(render([],'UTC'),/UTC/)
})

test('browser input in a shared session cannot inherit timestamps whose channel origin IDs were pruned',()=>{
 const text=render([user('expired-channel-id',now-2*hour),user('browser',now)])
 assert.doesNotMatch(text,/2 小时|上一条消息/)
})
