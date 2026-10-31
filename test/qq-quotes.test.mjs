import test from 'node:test'
import assert from 'node:assert/strict'
import {oneBotMessage} from '../lib/channels/qq/message.js'
import {resolveQqQuote,quotedMessageText} from '../lib/channels/qq/quote.js'
const bot='12345678',peer='87654321'
const event=()=>oneBotMessage({post_type:'message',message_type:'private',sub_type:'friend',self_id:Number(bot),user_id:Number(peer),message_id:7,message:[{type:'reply',data:{id:-123}},{type:'text',data:{text:'这个人你认识吗'}}]},bot)
const raw=(extra={})=>({message_id:-123,message_type:'private',user_id:Number(peer),target_id:Number(bot),sender:{user_id:Number(peer),nickname:'朋友'},message:[{type:'text',data:{text:'原文'}},{type:'image',data:{url:'https://gchat.qpic.cn/quoted.png'}}],...extra})
test('private reply retains signed ID and resolves text and image without replacing current words',async()=>{
 const e=event();assert.equal(e.qqReplyId,'-123');const calls=[]
 await resolveQqQuote(e,bot,async id=>{calls.push(id);return raw()},new AbortController().signal)
 assert.deepEqual(calls,[-123]);assert.equal(e.text,'这个人你认识吗');assert.match(quotedMessageText(e),/原文/);assert.match(quotedMessageText(e),/当前发言：\n这个人你认识吗/)
 assert.equal(e.qqQuote.media[0].source,'https://gchat.qpic.cn/quoted.png')
 await resolveQqQuote(e,bot,()=>assert.fail('must not fetch twice'),new AbortController().signal)
})
test('quotes never cross private peers or groups, and own sent private replies require a matching target',async()=>{
 for(const value of [raw({user_id:99999999,sender:{user_id:99999999}}),raw({target_id:99999999}),raw({message_type:'group',group_id:11111111}),raw({message_id:456}),raw({user_id:Number(bot),sender:{user_id:Number(bot)},target_id:undefined})]){
  const e=event();await resolveQqQuote(e,bot,async()=>value,new AbortController().signal);assert.match(e.qqQuote.text,/不可用/);assert.equal(e.qqQuote.media.length,0)
 }
 const e=event();await resolveQqQuote(e,bot,async()=>raw({sender:{user_id:Number(bot)},target_id:Number(peer)}),new AbortController().signal);assert.match(e.qqQuote.text,/原文/)
 const g={...event(),sender:'group:99887766:'+peer,qqGroup:{groupId:'99887766'}}
 await resolveQqQuote(g,bot,async()=>raw({message_type:'group',group_id:99887766,sender:{user_id:Number(bot)}}),new AbortController().signal);assert.equal(g.qqGroup.replyTo,'self')
 const wrong={...g,qqQuote:undefined};await resolveQqQuote(wrong,bot,async()=>raw({message_type:'group',group_id:99887765}),new AbortController().signal);assert.match(wrong.qqQuote.text,/不可用/)
})
test('failed/invalid/nested quotes are bounded, and actual cancellation propagates',async()=>{
 const e=event();await resolveQqQuote(e,bot,async()=>{throw Error('not found')},new AbortController().signal);assert.match(quotedMessageText(e),/不可用/)
 const invalid={...event(),qqReplyId:'http://localhost'};await resolveQqQuote(invalid,bot,()=>assert.fail(),new AbortController().signal);assert.match(invalid.qqQuote.text,/不可用/)
 const nested=event();let calls=0;await resolveQqQuote(nested,bot,async()=>{calls++;return raw({message:[{type:'reply',data:{id:999}},...Array(10).fill({type:'image',data:{url:'https://gchat.qpic.cn/a'}})]})},new AbortController().signal);assert.equal(calls,1);assert.equal(nested.qqQuote.media.length,4);assert.match(nested.qqQuote.text,/未展开/)
 const controller=new AbortController();await assert.rejects(resolveQqQuote(event(),bot,async()=>{controller.abort();return raw()},controller.signal))
})
