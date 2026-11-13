import test from 'node:test'
import assert from 'node:assert/strict'
import {QqRecentMedia} from '../lib/channels/qq/recent-media.js'
import {oneBotMessage} from '../lib/channels/qq/message.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
const event=(id='pic',extra={})=>({id,sender:'group:99887766:22345678',targetId:'group:99887766',text:'',timestamp:10000,qqGroup:{groupId:'99887766',userId:'22345678'},...extra})
const pic=(id='pic',extra={})=>event(id,{media:[{kind:'image',source:'https://gchat.qpic.cn/'+id}],...extra})
const caption=(extra={})=>event('caption',{text:'这个怎么样',timestamp:11000,...extra})
test('structured image, video and file segments are cached; voice is not automatically reused',()=>{
 const raw={post_type:'message',message_type:'group',self_id:12345678,user_id:22345678,group_id:99887766,message_id:1,message:['image','video','record','file'].map(type=>({type,data:{url:'https://gchat.qpic.cn/a'}}))}
 const parsed=oneBotMessage(raw,'12345678','',qqSettings({groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766']}))
 assert.deepEqual(parsed.media.map(m=>m.kind),['image','video','record','file'])
 const cache=new QqRecentMedia(()=>11000);cache.observe('c',parsed)
 assert.deepEqual(cache.select('c',caption(),[caption()])[0].media.map(m=>m.kind),['image','video','file'])
})
test('latest image burst is bounded, scoped, expires and is retired only when submitted',()=>{
 let now=11000;const cache=new QqRecentMedia(()=>now)
 for(let i=0;i<6;i++)cache.observe('c',pic('p'+i))
 const e=caption();const selected=cache.select('c',e,[e]);assert.equal(selected.length,4)
 assert.equal(cache.select('other',e,[e]).length,0)
 for(const changed of [{sender:'group:99887766:33445566'},{qqGroup:{groupId:'88776655',userId:'22345678'}},{timestamp:9000}])assert.equal(cache.select('c',caption(changed),[caption(changed)]).length,0)
 cache.submitted('c',selected);assert.equal(cache.select('c',e,[e]).length,0)
 cache.observe('c',pic());now=50000
 assert.equal(cache.select('c',caption({timestamp:now}),[caption()]).length,0)
 const reference=caption({timestamp:now,text:'刚才那张图是什么'});assert.equal(cache.select('c',reference,[reference]).length,1)
 now=131000;assert.equal(cache.select('c',reference,[reference]).length,0);assert.equal(cache.lanes.size,0)
})
test('current images, explicit quotes and redirected speech take precedence; original refs cannot mutate cache',()=>{
 const cache=new QqRecentMedia(()=>11000),p=pic();cache.observe('c',p);p.media[0].source='changed'
 assert.match(cache.select('c',caption(),[caption()])[0].media[0].source,/qpic/)
 for(const extra of [{media:[{kind:'image',source:'current'}]},{qqReplyId:'q'},{qqGroup:{...caption().qqGroup,hasReply:true}},{qqGroup:{...caption().qqGroup,otherMention:true}}]){const e=caption(extra);assert.equal(cache.select('c',e,[e]).length,0)}
 cache.observe('c',caption({qqGroup:{...caption().qqGroup,replyTo:'other'}}));assert.equal(cache.select('c',caption(),[caption()]).length,0)
 for(let i=0;i<300;i++)cache.observe('channel'+i,pic());assert.equal(cache.lanes.size,256)
})
test('four-image cap does not leak omitted older pictures into following replies; a newer upload survives old handoff',()=>{
 let now=11000;const cache=new QqRecentMedia(()=>now)
 for(let i=0;i<4;i++)cache.observe('c',pic('p'+i,{timestamp:10000+i,media:Array.from({length:4},(_,j)=>({kind:'image',source:'https://gchat.qpic.cn/'+i+j}))}))
 const selected=cache.select('c',caption(),[caption()]);assert.equal(selected.flatMap(e=>e.media).length,4)
 cache.submitted('c',selected);assert.equal(cache.select('c',caption(),[caption()]).length,0)
 cache.observe('c',pic('old'));const old=cache.select('c',caption(),[caption()])
 now=12000;cache.observe('c',pic('new',{timestamp:10000}));cache.submitted('c',old)
 assert.deepEqual(cache.select('c',caption({timestamp:13000}),[caption()]).map(e=>e.id),['new'])
})
