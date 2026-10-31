import test from 'node:test'
import assert from 'node:assert/strict'
import {channelReplyAllowed,directReplyTarget} from '../lib/channels/reply-access.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {DirectTransport} from '../lib/channels/direct/transport.js'
import {notificationRoutes} from '../lib/channels/notification-route.js'
import {QqGroupAutonomy} from '../lib/channels/qq/autonomy.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
import {qqIdentityRelation} from '../lib/channels/qq/identity-binding.js'

function fixture() {
 const peer='group:99887766:22345678',target='group:99887766'
 const channel={id:'qq',platform:'qq',accountId:'12345678',companionId:'c',enabled:true,direct:{baseUrl:'ws://local',targetId:'',peerId:''},qq:qqSettings({privateReplies:false,groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766']})}
 const state={channels:[channel],companions:[{id:'c'}],sessions:[{id:'r',kind:'channel',channelId:'qq',companionId:'c',sessionId:'s',userId:peer}],pairings:[],recentReceipts:[],notificationDeliveries:[]}
 const store={snapshot:()=>structuredClone(state),update:async fn=>{fn(state);return structuredClone(state)},isCompanionRemoving:()=>false}
 const sent=[],inputs=[]
 let reply={text:'你好',attachments:[]}
 const agents={isCompanionBusy:()=>false,reply:async(...args)=>{inputs.push(args);return reply}}
 const manager=new ChannelManager({logger:{warn(){}}},store,{read:async()=>({baseUrl:'ws://local',botToken:'test'})},agents,'/tmp')
 const api={config:{targetId:target},sendText:async(userId,text)=>sent.push({userId,text}),sendAttachment:async(userId,attachment)=>sent.push({userId,attachment})}
 const event={id:'m',sender:peer,targetId:target,text:'你好',qqGroup:{groupId:'99887766',userId:'22345678',senderName:'访客',mentioned:true,autonomous:true}}
 return {peer,target,channel,state,store,sent,inputs,agents,manager,api,event,setReply:r=>{reply=r},handle:e=>manager.handleDirect(channel,api,e??event,new AbortController().signal)}
}
test('whitelisted QQ groups grant chat without granting private access, identity relationships or another room',()=>{
 const f=fixture()
 assert.equal(channelReplyAllowed(f.state,'qq',f.peer,f.target),true)
 assert.equal(directReplyTarget(f.state,'qq',f.peer),f.target)
 assert.deepEqual(notificationRoutes(f.state,'qq',f.peer),[{channelId:'qq',userId:f.peer}])
 for(const peer of ['22345678','group:88776655:22345678','group:99887766:invalid'])assert.equal(channelReplyAllowed(f.state,'qq',peer),false)
 assert.equal(channelReplyAllowed(f.state,'qq',f.peer,'group:88776655'),false)
 assert.equal(qqIdentityRelation(f.channel.qq,f.peer).matched,false)
 f.state.pairings.push({channelId:'qq',userId:'22345678',status:'approved'})
 f.channel.qq.identityBinding={enabled:true,qqIds:['22345678']}
 assert.equal(channelReplyAllowed(f.state,'qq','22345678'),false,'owner binding cannot bypass disabled private replies')
 f.channel.qq.privateReplies=true;assert.equal(channelReplyAllowed(f.state,'qq','22345678'),true)
})
test('a new group member receives normal text without any pairing request; closed private chat stays silent',async()=>{
 const f=fixture();await f.handle();assert.equal(f.inputs.length,1);assert.deepEqual(f.sent,[{userId:f.peer,text:'你好'}]);assert.deepEqual(f.state.pairings,[])
 f.sent.length=0
 await f.handle({id:'private',sender:'22345678',targetId:'22345678',text:'请回复'})
 assert.equal(f.inputs.length,1);assert.deepEqual(f.sent,[]);assert.deepEqual(f.state.pairings,[])
})
test('all unpaired whitelist members enter autonomous judgment, which may reply or remain silent',async()=>{
 for(const decision of [true,false]){
  const f=fixture();let judged=0
  f.manager.groupAutonomy.shouldReply=async()=>{judged++;return decision}
  await f.handle({...f.event,qqGroup:{...f.event.qqGroup,mentioned:false}})
  assert.equal(judged,1);assert.equal(f.inputs.length,decision?1:0);assert.equal(f.sent.length,decision?1:0);assert.deepEqual(f.state.pairings,[])
 }
})
test('unpaired group delivery resolves its real target for segmented text and native QQ faces',async()=>{
 const f=fixture(),api=Object.create(DirectTransport.prototype)
 api.config={platform:'qq',targetId:f.target};api.sendText=f.api.sendText
 Object.defineProperty(api,'onebot',{value:{sendFace:async(userId,id,signal,guard)=>{guard();f.sent.push({userId,face:id})}}})
 f.manager.directTransports.set('qq',{forTarget(target,expected,authorize){assert.equal(target,f.target);assert.equal(expected.peerId,f.peer);authorize();return api}})
 f.setReply({text:'你好',attachments:[],chatParts:[{type:'text',text:'你好'},{type:'emoji',emoji:{provider:'qq',channelId:'qq',accountId:f.channel.accountId,id:'14',label:'微笑'}},{type:'text',text:'又见面了'}]})
 await f.handle()
 assert.deepEqual(f.sent,[{userId:f.peer,text:'你好'},{userId:f.peer,face:'14'},{userId:f.peer,text:'又见面了'}]);assert.deepEqual(f.state.pairings,[])
})
test('removal, blocked members and group disable deny both inbound and late reply',async()=>{
 for(const revoke of [f=>f.channel.qq.groupIds=[],f=>f.channel.qq.groupReplies=false,f=>f.state.pairings.push({channelId:'qq',userId:f.peer,status:'blocked'})]){
  const f=fixture();revoke(f);await f.handle();assert.equal(f.inputs.length,0);assert.equal(f.sent.length,0)
  const late=fixture();late.agents.reply=async()=>{revoke(late);return {text:'late',attachments:[]}}
  await assert.rejects(late.handle(),/撤销/);assert.deepEqual(late.sent,[])
 }
})
test('pending legacy group pairing no longer prevents group chat; non-QQ channels still require approval',async()=>{
 const f=fixture();f.state.pairings.push({channelId:'qq',userId:f.peer,status:'pending',directTargetId:f.target});await f.handle();assert.equal(f.sent.length,1)
 for(const platform of ['matrix','mattermost','weixin']){f.channel.platform=platform;assert.equal(channelReplyAllowed(f.state,'qq',f.peer),false)}
})

test('queued private messages use current settings and cannot issue a pairing code after private chat closes',async()=>{
 const f=fixture();f.channel.qq.privateReplies=true
 f.state.channels[0]={...f.channel,qq:{...f.channel.qq,privateReplies:false}}
 await f.handle({id:'queued-private',sender:'22345678',targetId:'22345678',text:'hello'})
 assert.deepEqual(f.sent,[]);assert.deepEqual(f.inputs,[]);assert.deepEqual(f.state.pairings,[])
})

test('non-whitelisted connected group requires member approval, which never approves private chat',async()=>{
 const f=fixture();f.channel.qq.autonomousGroupIds=[];f.channel.qq.privateReplies=true
 const event={...f.event,qqGroup:{...f.event.qqGroup,autonomous:false}}
 await f.handle(event)
 assert.equal(f.inputs.length,0);assert.equal(f.state.pairings.length,1);assert.equal(f.state.pairings[0].status,'pending');assert.match(f.sent[0].text,/配对码/)
 f.sent.length=0
 await f.handle({...event,id:'still-pending'})
 assert.equal(f.inputs.length,0);assert.equal(f.sent.length,0)
 f.state.pairings[0].status='approved'
 await f.handle({...event,id:'approved'})
 assert.equal(f.inputs.length,1);assert.deepEqual(f.sent,[{userId:f.peer,text:'你好'}])
 f.sent.length=0
 await f.handle({id:'private-needs-approval',sender:'22345678',targetId:'22345678',text:'你好'})
 assert.equal(f.inputs.length,1);assert.match(f.sent[0].text,/配对码/)
 assert.equal(f.state.pairings.find(p=>p.userId==='22345678').status,'pending')
})
test('private approval never grants non-whitelisted group access and whitelist revocation takes effect immediately',()=>{
 const f=fixture();f.channel.qq.privateReplies=true;f.channel.qq.autonomousGroupIds=[]
 f.state.pairings.push({channelId:'qq',userId:'22345678',status:'approved'})
 assert.equal(channelReplyAllowed(f.state,'qq','22345678'),true)
 assert.equal(channelReplyAllowed(f.state,'qq',f.peer),false)
 f.channel.qq.autonomousGroupIds=['99887766'];assert.equal(channelReplyAllowed(f.state,'qq',f.peer),true)
 f.channel.qq.autonomousGroupIds=[];assert.equal(channelReplyAllowed(f.state,'qq',f.peer),false)
 f.state.pairings.push({channelId:'qq',userId:f.peer,status:'approved',directTargetId:f.target});assert.equal(channelReplyAllowed(f.state,'qq',f.peer),true)
})

test('two rapid admitted messages are both locally judged while busy, without a model request',async()=>{
 const f=fixture(),judged=[]
 Object.assign(f.state.companions[0],{name:'朋友',role:'朋友',instructions:'自然聊天'})
 f.agents.isCompanionBusy=()=>true
 f.manager.groupAutonomy=new QqGroupAutonomy({get:()=>{throw Error('no model needed')}},()=>100000)
 const decide=f.manager.groupAutonomy.shouldReply.bind(f.manager.groupAutonomy)
 f.manager.groupAutonomy.shouldReply=async(...args)=>{judged.push(args[1].text);return decide(...args)}
 for(const [id,text] of [['first','朋友，你刚刚在做什么'],['second','不用回复了']])await f.handle({...f.event,id,text,qqGroup:{...f.event.qqGroup,mentioned:false}})
 assert.deepEqual(judged,['朋友，你刚刚在做什么','不用回复了'])
 assert.equal(f.inputs.length,1);assert.equal(f.sent.length,1)
 assert.match(f.manager.groupAutonomy.status('qq').reason,/决定旁听/)
 assert.ok(f.state.recentReceipts.includes('qq:first'));assert.ok(f.state.recentReceipts.includes('qq:second'))
 assert.equal(f.manager.qqLatency.view('qq')[0].decisionMethod,'local')
 assert.equal(f.manager.qqLatency.view('qq')[1].decisionScore,0)
})

test('steered QQ supplement is consumed without sending a channel acknowledgement',async()=>{
 const f=fixture();let steered=0
 f.agents.steer=async()=>{steered++;return true}
 await f.manager.handleDirect(f.channel,f.api,f.event,new AbortController().signal,[f.event],()=>{},'steer')
 assert.equal(steered,1);assert.equal(f.inputs.length,0);assert.deepEqual(f.sent,[])
 assert.ok(f.state.recentReceipts.includes('qq:m'))
 assert.equal(f.manager.qqLatency.view('qq')[0].outcome,'steered')
})

test('only delivered replies establish continuation; failed sends and revoked access do not',async()=>{
 for(const mode of ['success','failed','revoked','silent']){
  const f=fixture(),replied=[]
  f.manager.groupAutonomy.replied=(...args)=>replied.push(args)
  if(mode==='failed')f.api.sendText=async()=>{throw Error('send failed')}
  if(mode==='revoked')f.agents.reply=async()=>{f.channel.qq.groupReplies=false;return {text:'late',attachments:[]}}
  if(mode==='silent')f.setReply({text:'',attachments:[],chatParts:[]})
  if(mode==='failed'||mode==='revoked')await assert.rejects(f.handle())
  else await f.handle()
  assert.equal(replied.length,mode==='success'?1:0,mode)
  if(mode==='silent'){assert.deepEqual(f.sent,[]);assert.equal(f.manager.qqLatency.view('qq')[0].outcome,'silent')}
 }
})

test('post-reply opportunities arm only after all reply parts succeed, never on silence or failure',async()=>{
 for(const outcome of ['success','failure','silent']){
  const f=fixture(),armed=[]
  f.agents.replyDelivered=async source=>{armed.push(source);assert.ok(f.sent.length)}
  const source={routeId:'r',sessionId:'s',userMessageId:'user'}
  f.setReply(outcome==='silent'?{text:'',attachments:[],chatParts:[],postReplySource:source}:{text:'你好',attachments:[],postReplySource:source})
  if(outcome==='failure')f.api.sendText=async()=>{throw Error('send failed')}
  if(outcome==='failure')await assert.rejects(f.handle());else await f.handle()
  assert.equal(armed.length,outcome==='success'?1:0)
 }
})

test('approved QQ quotes carry text and image into the agent; failed quote downloads keep current input',async()=>{
 for(const fail of [false,true]){
  const f=fixture();f.event.qqReplyId='-123';f.event.text='这个人你认识吗';const calls=[]
  f.api.onebot={connection:{call:async(name,params)=>{calls.push(name);return name==='get_msg'?{message_id:-123,message_type:'group',group_id:99887766,sender:{user_id:22345678,nickname:'朋友'},message:[{type:'text',data:{text:'引用文字'}},{type:'image',data:{url:'https://gchat.qpic.cn/a'}}]}:{group_name:'测试'}}}}
  f.api.receiveAttachments=async()=>{if(fail)throw Error('expired');return [{name:'quote.png',mediaType:'image/png',data:Buffer.from('image')}]}
  await f.handle();assert.equal(f.inputs.length,1);assert.match(f.inputs[0][3].text,/引用文字/);assert.match(f.inputs[0][3].text,/这个人你认识吗/)
  assert.equal(f.inputs[0][3].attachments.length,fail?0:1);if(fail)assert.match(f.inputs[0][3].text,/引用附件读取失败/)
  assert.equal(calls.filter(n=>n==='get_msg').length,1)
 }
 const blocked=fixture();blocked.event.qqReplyId='-123';blocked.state.pairings=[{channelId:'qq',userId:blocked.peer,status:'blocked'}];blocked.api.onebot={connection:{call:()=>assert.fail('unauthorized quote fetch')}};await blocked.handle();assert.equal(blocked.inputs.length,0)
})

test('voice already delivered by tool needs no extra message and counts as a successful reply',async()=>{
 const f=fixture(),source={routeId:'r',sessionId:'s',userMessageId:'u'},armed=[]
 f.agents.replyDelivered=async value=>armed.push(value)
 f.setReply({text:'',attachments:[],chatParts:[],alreadyDelivered:true,postReplySource:source})
 await f.handle()
 assert.deepEqual(f.sent,[]);assert.deepEqual(armed,[source]);assert.equal(f.manager.qqLatency.view('qq')[0].outcome,'replied')
})
