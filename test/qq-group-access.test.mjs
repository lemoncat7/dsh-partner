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

test('QQ polling merges a speaker burst and steers subsequent additions even with global queue setting',{timeout:15000},async t=>{
 const f=fixture(),controller=new AbortController(),seen=[]
 f.manager.ctx.settings={get:()=> 'queue'}
 let polls=0,release,secondSent=false
 f.agents.groupReplyFocus=()=>seen.length?{userId:f.peer,startedAt:Date.now()-10000,working:true}:undefined
 const end=new Promise(r=>release=r)
 t.after(()=>{controller.abort();release()})
 f.agents.reply=async(_c,_channel,_sender,input,updates)=>{
  seen.push({text:input.text,attachments:input.attachments})
  if(seen.length===1)await end
  else release()
  return {text:'',attachments:[]}
 }
 f.agents.steer=async(_c,_ch,_sender,input)=>{if(!seen.length)return false;seen.push({text:input.text,attachments:input.attachments});release();return true}
 t.mock.method(DirectTransport.prototype,'validate',async()=>({accountId:f.channel.accountId,peerId:f.peer}))
 t.mock.method(DirectTransport.prototype,'poll',async()=>{
  polls++
  if(f.state.recentReceipts.includes('qq:three'))controller.abort()
  if(polls===1)return {messages:[{...f.event,id:'one',text:'帮我看看'}]}
  if(polls===2)return {messages:[{...f.event,id:'two',text:'还有这条',media:[{source:'test-image'}]}]}
  if(seen.length===1&&!secondSent){secondSent=true;return {messages:[{...f.event,id:'three',text:'等等先别做',qqGroup:{...f.event.qqGroup,mentioned:false}}]}}
  await new Promise(r=>setTimeout(r,20));return {messages:[]}
 })
 t.mock.method(DirectTransport.prototype,'receiveAttachments',async()=>[{kind:'image',name:'image.png',data:Buffer.from('image')}])
 t.mock.method(DirectTransport.prototype,'sendText',async()=>{})
 await f.manager.directLoop(f.channel,controller.signal)
 assert.equal(seen.length,2);assert.match(seen[0].text,/帮我看看[\s\S]*还有这条/);assert.equal(seen[0].attachments.length,1)
 assert.match(seen[1].text,/等等先别做/)
 for(const id of ['one','two','three'])assert.ok(f.state.recentReceipts.includes('qq:'+id))
})

test('busy group task ignores a flood without steering, queuing replies or loading attachments',async()=>{
 const f=fixture();let steers=0,downloads=0,judgments=0
 f.agents.groupReplyFocus=()=>({userId:f.peer,startedAt:Date.now()-60000,working:true})
 f.agents.steer=async()=>{steers++;return true}
 f.api.receiveAttachments=async()=>{downloads++;return []}
 f.manager.groupAutonomy.shouldReply=async()=>{judgments++;return true}
 for(let i=0;i<120;i++){
  const e={...f.event,id:'noise-'+i,sender:i%2?f.peer:'group:99887766:33445566',text:['？','干活中不会发消息的','他好像真去','表情包还挺好用'][i%4],media:i%3?[]:[{source:'https://invalid.test/img'}],qqGroup:{...f.event.qqGroup,userId:i%2?'22345678':'33445566',mentioned:false}}
  await f.manager.handleDirect(f.channel,f.api,e,new AbortController().signal,[e],()=>{},'steer')
 }
 assert.equal(steers,0);assert.equal(downloads,0);assert.equal(judgments,0);assert.equal(f.inputs.length,0);assert.deepEqual(f.sent,[])
 assert.match(f.manager.groupAutonomy.status('qq').reason,/仅旁听/)
})

test('busy group task queues explicit requests but lets its author cancel without waiting for them',async()=>{
 const f=fixture();let release,started
 const waiting=new Promise(r=>{release=r}),ready=new Promise(r=>{started=r}),steered=[]
 f.agents.groupReplyFocus=()=>({userId:f.peer,startedAt:Date.now()-60000,working:true})
 f.agents.steer=async(...args)=>{steered.push(args[3].text);return true}
 f.agents.reply=async()=>{started();await waiting;return {text:'',attachments:[],chatParts:[]}}
 const e={...f.event,id:'next',sender:'group:99887766:33445566',text:'也帮我查一下',qqGroup:{...f.event.qqGroup,userId:'33445566'}}
 const queued=f.manager.handleDirect(f.channel,f.api,e,new AbortController().signal,[e],()=>{},'steer')
 await ready
 for(const [id,text] of [['change','改成写实画风'],['cancel','停一下']]){
  const e={...f.event,id,text,qqGroup:{...f.event.qqGroup,mentioned:false}}
  await f.manager.handleDirect(f.channel,f.api,e,new AbortController().signal,[e],()=>{},'steer')
 }
 assert.equal(steered.length,2);assert.match(steered[0],/改成写实/);assert.match(steered[1],/停一下/)
 release();await queued;assert.deepEqual(f.sent,[])
})

test('task starting during classification rechecks admission before steering',async()=>{
 const f=fixture();let busy=false
 f.agents.groupReplyFocus=()=>busy?{userId:f.peer,startedAt:Date.now()-60000,working:true}:undefined
 f.manager.groupAutonomy.shouldReply=async()=>{busy=true;return true}
 f.agents.steer=async()=>{throw Error('noise must not enter inbox')}
 const e={...f.event,text:'他好像真去',qqGroup:{...f.event.qqGroup,mentioned:false}}
 await f.manager.handleDirect(f.channel,f.api,e,new AbortController().signal,[e],()=>{},'steer')
 assert.deepEqual(f.inputs,[]);assert.deepEqual(f.sent,[])
})

test('busy admission reads the current words rather than treating quoted text as task control',async()=>{
 const f=fixture(),steered=[]
 f.agents.groupReplyFocus=()=>({userId:f.peer,startedAt:Date.now()-60000,working:true})
 f.agents.steer=async(...args)=>{steered.push(args[3].text);return true}
 const quote={text:'取消任务',media:[]}
 const noise={...f.event,id:'quoted-noise',text:'他说了这句',qqQuote:quote,qqGroup:{...f.event.qqGroup,mentioned:false}}
 await f.manager.handleDirect(f.channel,f.api,noise,new AbortController().signal,[noise],()=>{},'steer')
 assert.equal(steered.length,0);assert.equal(f.inputs.length,0)
 const control={...noise,id:'quoted-control',text:'停一下',qqQuote:{text:'原先的工作',media:[]},qqGroup:{...noise.qqGroup,replyTo:'self'}}
 await f.manager.handleDirect(f.channel,f.api,control,new AbortController().signal,[control],()=>{},'steer')
 assert.equal(steered.length,1);assert.match(steered[0],/停一下/)
})

test('a cancellation at the end of a merged burst is not hidden by its opening chatter',async()=>{
 const f=fixture(),steered=[]
 f.agents.groupReplyFocus=()=>({userId:f.peer,startedAt:Date.now()-60000,working:true})
 f.agents.steer=async(...args)=>{steered.push(args[3].text);return true}
 const first={...f.event,id:'aside',text:'？',qqGroup:{...f.event.qqGroup,mentioned:false}}
 const last={...first,id:'stop',text:'取消任务'}
 await f.manager.handleDirect(f.channel,f.api,first,new AbortController().signal,[first,last],()=>{},'steer')
 assert.equal(steered.length,1);assert.match(steered[0],/取消任务/);assert.deepEqual(f.sent,[])
})

test('first confirmed segment closes same-speaker admission until the reply finishes, including buffered input',{timeout:10000},async()=>{
 const f=fixture();let release,secondReady,steers=0,replies=0
 const second=new Promise(r=>secondReady=r),finish=new Promise(r=>release=r)
 const api=Object.create(DirectTransport.prototype);api.config={platform:'qq',targetId:f.target}
 api.sendText=async(_peer,text)=>{f.sent.push(text);if(text==='第二段'){secondReady();await finish}}
 f.manager.directTransports.set('qq',{forTarget:()=>api})
 f.agents.steer=async()=>{steers++;return false}
 f.manager.groupAutonomy.shouldReply=async()=>true
 f.agents.reply=async(_c,_ch,_u,_m,progress)=>{replies++;progress('working');return replies===1?{text:'',attachments:[],chatParts:[{type:'text',text:'第一段'},{type:'text',text:'第二段'}]}:{text:'新的回复',attachments:[]}}
 const first={...f.event,id:'first-segments',receivedAt:Date.now()}
 const pending=f.manager.handleDirect(f.channel,f.api,first,new AbortController().signal,[first],()=>{},'steer')
 await second
 const receivedAt=Date.now()
 const noise={...f.event,id:'during-segments',receivedAt,text:'还有一点随口说的',qqGroup:{...f.event.qqGroup,mentioned:false}}
 await f.manager.handleDirect(f.channel,f.api,noise,new AbortController().signal,[noise],()=>{},'steer')
 assert.equal(replies,1);assert.equal(steers,1,'only the first request tried an idle steer')
 release();await pending
 const buffered={...noise,id:'already-buffered',receivedAt}
 await f.manager.handleDirect(f.channel,f.api,buffered,new AbortController().signal,[buffered],()=>{},'steer')
 assert.equal(replies,1);assert.equal(f.manager.groupReplyWindows.active.size,0)
 const fresh={...noise,id:'fresh-after',receivedAt:Date.now()+1,text:'现在另聊一件事'}
 await f.manager.handleDirect(f.channel,f.api,fresh,new AbortController().signal,[fresh],()=>{},'steer')
 assert.equal(replies,2);assert.equal(f.sent.at(-1).text,'新的回复')
})

test('first segment failure is not a sent reply and leaves no finished suppression window',async()=>{
 const f=fixture(),api=Object.create(DirectTransport.prototype);api.config={platform:'qq',targetId:f.target};api.sendText=async()=>{throw Error('not delivered')}
 f.manager.directTransports.set('qq',{forTarget:()=>api})
 f.agents.reply=async(_c,_ch,_u,_m,progress)=>{progress('working');return {text:'',attachments:[],chatParts:[{type:'text',text:'未送达'}]}}
 await assert.rejects(f.handle(),/投递失败/)
 assert.equal(f.manager.groupReplyWindows.active.size,0);assert.equal(f.manager.groupReplyWindows.recent.size,0)
})

test('silently observed image is attached to a later caption, without downloading bystander pictures or repeating it',async()=>{
 const f=fixture(),downloads=[]
 f.manager.groupAutonomy.shouldReply=async(_c,e)=>!!e.text
 f.api.receiveAttachments=async e=>{downloads.push(e.id);return [{kind:'image',name:'prior.png',data:Buffer.from('image'),mediaType:'image/png'}]}
 const picture={...f.event,id:'prior-picture',text:'',timestamp:Date.now()-2000,qqGroup:{...f.event.qqGroup,mentioned:false},media:[{kind:'image',source:'https://gchat.qpic.cn/a'}]}
 await f.handle(picture);assert.equal(f.inputs.length,0);assert.deepEqual(downloads,[])
 await f.handle({...f.event,id:'caption',text:'这张图怎么样',timestamp:Date.now()})
 assert.deepEqual(downloads,['prior-picture']);assert.equal(f.inputs[0][3].attachments.length,1)
 assert.match(f.inputs[0][3].text,/补附同一发言人/);assert.match(f.inputs[0][3].text,/这张图怎么样/)
 await f.handle({...f.event,id:'next',text:'再说两句'});assert.equal(f.inputs[1][3].attachments.length,0)
 assert.ok(f.state.recentReceipts.includes('qq:prior-picture'))
})
test('historical image failure keeps caption; revoked access does not admit it; cancellation propagates',async()=>{
 for(const mode of ['failure','revoked','cancelled']){
  const f=fixture(),controller=new AbortController()
  f.manager.groupAutonomy.shouldReply=async(_c,e)=>!!e.text
  const picture={...f.event,id:'pic',text:'',timestamp:Date.now()-1000,media:[{kind:'image',source:'https://gchat.qpic.cn/a'}]}
  await f.handle(picture)
  f.api.receiveAttachments=async()=>{if(mode==='revoked')f.channel.qq.groupReplies=false;if(mode==='cancelled')controller.abort();throw Error('expired')}
  const e={...f.event,id:'caption',text:'看这张图'}
  const pending=f.manager.handleDirect(f.channel,f.api,e,controller.signal)
  if(mode==='failure'){await pending;assert.equal(f.inputs.length,1);assert.match(f.inputs[0][3].text,/先前附件未能读取/);assert.equal(f.inputs[0][3].attachments.length,0)}
  else {await assert.rejects(pending);assert.equal(f.inputs.length,0)}
 }
})
test('whole text/image burst downloads originals once, not again as historical images',async()=>{
 for(const imageFirst of [true,false]){
  const f=fixture(),downloads=[]
  f.api.receiveAttachments=async e=>{downloads.push(e.id);return [{kind:'image',name:'a.png',data:Buffer.from('a')}]}
  const p={...f.event,id:'p',text:'',media:[{kind:'image',source:'https://gchat.qpic.cn/a'}]},c={...f.event,id:'caption',text:'帮我看看'}
  const batch=imageFirst?[p,c]:[c,p]
  await f.manager.handleDirect(f.channel,f.api,batch[0],new AbortController().signal,batch)
  assert.deepEqual(downloads,['p']);assert.equal(f.inputs[0][3].attachments.length,1)
 }
})

test('silently observed file or video is attached to the later same-speaker explanation',async()=>{
 for(const kind of ['file','video']){
  const f=fixture(),downloads=[]
  f.manager.groupAutonomy.shouldReply=async(_c,e)=>!!e.text
  f.api.receiveAttachments=async e=>{downloads.push(e.id);return [{kind:'file',name:kind==='file'?'workflow.json':'video.mp4',data:Buffer.from('bytes')}]}
  await f.handle({...f.event,id:'prior-'+kind,text:'',timestamp:Date.now()-2000,media:[{kind,source:kind==='video'?'https://multimedia.nt.qq.com.cn/v':'',...(kind==='file'?{fileId:'f'}:{})}]})
  assert.deepEqual(downloads,[])
  await f.handle({...f.event,id:'followup',text:'帮我看看这个',timestamp:Date.now()})
  assert.deepEqual(downloads,['prior-'+kind]);assert.equal(f.inputs[0][3].attachments.length,1);assert.match(f.inputs[0][3].text,/先前附件资料/)
 }
})

test('real group intake gives the next participant shared-conversation guidance after confirmed delivery',async()=>{
 const f=fixture();f.state.companions[0].characterCard={enabled:true}
 f.manager.groupAutonomy=new QqGroupAutonomy({},()=>Date.now(),async()=>({label:'engage',confidence:.41,margin:.21,contextSimilarity:.71}))
 await f.handle({...f.event,text:'来聊这个话题'})
 const b={...f.event,id:'second-participant',sender:'group:99887766:33445678',text:'我也觉得刚才这个很有意思',qqGroup:{...f.event.qqGroup,userId:'33445678',mentioned:false}}
 await f.handle(b)
 assert.equal(f.inputs.length,2);assert.equal(f.sent.length,2)
 const prompt=f.inputs[1][3].text
 assert.match(prompt,/参与状态（真实发送记录）/);assert.match(prompt,/其他成员顺着话题/)
 assert.doesNotMatch(prompt,/别人之间的交流安静旁听/);assert.match(prompt,/明确发给其他人的消息/)
 assert.equal(f.manager.groupAutonomy.status('qq').route,'continuation')
})
