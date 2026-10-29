import test from 'node:test'
import assert from 'node:assert/strict'
import {StickerAdapters,validNativeEmoji} from '../lib/chat/sticker-adapter.js'
import {qqStickerAdapter} from '../lib/channels/qq/sticker-adapter.js'
import {qqCustomCatalog} from '../lib/channels/qq/catalog.js'
import {chatReplyFromEvent,replyDeliveryParts} from '../lib/chat/protocol.js'
const item={id:'builtin-happy',name:'开心',tags:['微笑'],mediaType:'image/png',size:1},data=Buffer.from([1])
const library={list:async()=>[item],image:async()=>({item,data})}
const channel={id:'qq',platform:'qq',enabled:true,companionId:'c',accountId:'12345678'}
const faces=[{id:'14',name:'/微笑',category:'经典',image:'https://qzonestyle.gtimg.cn/qzone/em/e100.gif'}]
const signal=AbortSignal.timeout(5000)
test('default stays unchanged; only a known QQ origin uses channel-specific stickers',async()=>{
 const registry=new StickerAdapters(library)
 registry.register('qq',c=>qqStickerAdapter(c,registry.fallback,async()=>faces))
 assert.equal((await registry.forRoute(undefined,[channel]).resolve('c',item.id,signal)).data,data)
 const adapter=registry.forRoute({channelId:'qq',companionId:'c'},[channel])
 assert.equal((await adapter.list('c','微笑',signal))[0].id,'qq-face-14')
 assert.equal((await adapter.resolve('c','qq-face-14',signal)).native.id,'14')
 assert.equal((await adapter.resolve('c','builtin-happy',signal)).native.id,'14')
 assert.equal((await registry.forRoute({channelId:'qq',companionId:'other'},[channel]).resolve('c',item.id,signal)).data,data)
})
test('default preference and unavailable catalogs fall back before sending; custom IDs remain bound to their account',async()=>{
 const fallback=new StickerAdapters(library).fallback
 assert.equal((await qqStickerAdapter({...channel,qq:{stickerSource:'default'}},fallback,async()=>faces).resolve('c',item.id,signal)).data,data)
 assert.equal((await qqStickerAdapter(channel,fallback,async()=>{throw Error('offline')}).resolve('c',item.id,signal)).data,data)
 const custom=qqCustomCatalog([{emoji_id:'favorite-full-id',desc:'得意',url:'https://gchat.qpic.cn/favorite.gif'}])
 const adapter=qqStickerAdapter(channel,fallback,async()=>custom),list=await adapter.list('c','得意',signal)
 const result=await adapter.resolve('c',list[0].id,signal)
 assert.equal(result.native.provider,'qq-custom');assert.equal(result.native.id,'favorite-full-id');assert.equal(result.native.accountId,channel.accountId)
 assert.equal(validNativeEmoji(result.native),true)
 assert.equal(validNativeEmoji({...result.native,previewUrl:'https://evil.example/x'}),false)
})
test('native emoji replies preserve text order and survive transcript and notification projection',()=>{
 const emoji={provider:'qq',id:'14',channelId:'qq',accountId:'12345678',label:'微笑'}
 const parts=[{type:'text',text:'你好'},{type:'emoji',emoji}]
 const event={type:'tool/result',data:{message:{},meta:{kind:'partner-chat-v1',parts}}}
 assert.deepEqual(chatReplyFromEvent(event).parts,parts)
 assert.deepEqual(replyDeliveryParts({text:'你好',attachments:[],chatParts:parts}),parts)
 assert.deepEqual(replyDeliveryParts({text:'你好',attachments:[],chatParts:parts,attachmentPolicy:'text-only'}),[{type:'text',text:'你好'},{type:'text',text:''}])
})
