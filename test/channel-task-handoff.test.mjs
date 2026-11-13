import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
const tick=()=>new Promise(r=>setImmediate(r))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('QQ input during silent autonomous work starts an owned reply and delivers preamble, image, and final text',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const session=Session.create('handoff'),sent=[],autonomy=deferred(),started=deferred(),finish=deferred()
 const channel={id:'qq',platform:'qq',accountId:'bot',companionId:'c',enabled:true,direct:{baseUrl:'http://local',targetId:'room'},qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}
 const companion={id:'c',toolDiscovery:true},route={id:'r',kind:'channel',channelId:'qq',userId:'12345678',companionId:'c',sessionId:session.id,qqSessionMode:'separate',inboundMessageIds:['old'],cwd:'/tmp'}
 const state={companions:[companion],channels:[channel],sessions:[route],pairings:[{channelId:'qq',userId:route.userId,status:'approved',directTargetId:'room'}],recentReceipts:[]}
 const store={snapshot:()=>state,subscribe:()=>()=>{},update:async fn=>fn(state),isCompanionRemoving:()=>false}
 const agent={session,status:'running',options:{},steer:()=>assert.fail('autonomous execution must not absorb user input')},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 let work=autonomy.promise.then(()=>{agent.status='idle';session.append('turn/end',{turn:1,reason:{kind:'completed'}})})
 agent.whenIdle=()=>work
 session.append('turn/start',{turn:1})
 session.append('user/message',{...createUserMessage({source:{kind:'user'},content:[{type:'text',text:'old'}]}),id:'old'},{surfaceOp:'append'})
 session.append('user/message',createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[{type:'text',text:'自主活动'}]}),{surfaceOp:'append'})
 session.append('tool/ptc-dispatch',{name:'partner_activity_finish',isError:false,meta:{kind:'partner-activity-silent-v1'}})
 const ctx={tools:root.tools,on:()=>()=>{},agents:{get:()=>agent},logger:{info:()=>{},warn:()=>{}}}
 const runtime=new PartnerAgentRuntime(ctx,store,'/tmp')
 runtime.ensureSession=async()=>route;runtime.ensureAgent=async()=>agent;runtime.cancelPostReply=async()=>{}
 runtime.persistInbound=async(_route,message)=>({query:message.text,content:[{type:'text',text:message.text}]})
 runtime.replyDelivered=async()=>{}
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[]))
 const def=(name,execute)=>({name,description:name,parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute})
 t.after(scope.ctx.tools.register(def('generate_image',async()=>{sent.push('image generated');return {ok:true}})))
 t.after(scope.ctx.tools.register(def('partner_send_attachment',async()=>{sent.push('image sent');return {ok:true}})))
 let calls=0
 const call=async(name,args={})=>{const request={name,arguments:args,agent,callId:'call-'+calls++,signal:new AbortController().signal};agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId:request.callId});const result=await dispatchTool(root.tools, request);agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{id:request.callId,role:'tool',source:{kind:'tool',callId:request.callId},toolCallId:request.callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 agent.followup=message=>{
  agent.status='running';session.append('turn/start',{turn:2});session.append('user/message',message,{surfaceOp:'append'})
  work=(async()=>{
   assert.equal(runtime.channelReplyOwners.get(session.id),route.id)
   const blocked=await call('generate_image');assert.equal(blocked.isError,true);assert.deepEqual(sent,[])
   const ack=await call('partner_chat_say',{beforeTools:true,expectedTools:['generate_image'],text:'这回我照着原来的样子画张近照，等着看吧。'})
   assert.equal(ack.isError,false);assert.equal(ack.isError,false)
   assert.equal((await call('generate_image')).isError,false)
   assert.equal((await call('partner_send_attachment')).isError,false)
   started.resolve();await finish.promise
   session.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'画好啦，看这次的表情。'}]}},{surfaceOp:'append'})
   session.append('turn/end',{turn:2,reason:{kind:'completed'}});agent.status='idle'
  })()
 }
 const manager=new ChannelManager({logger:ctx.logger},store,{},runtime,'/tmp')
 const api={config:channel.direct,sendText:async(_peer,text)=>sent.push(text),progress:()=>undefined}
 const event={id:'request',sender:route.userId,text:'再画一张近照',targetId:'room'}
 const pending=manager.handleDirect(channel,api,event,new AbortController().signal,[event],()=>{},'steer')
 await tick();assert.deepEqual(sent,[])
 autonomy.resolve();await started.promise
 assert.deepEqual(sent,['这回我照着原来的样子画张近照，等着看吧。','image generated','image sent'])
 let steered
 agent.steer=message=>{steered=message}
 assert.equal(await runtime.steer(companion,channel.id,route.userId,{text:'背景也保持原样',attachments:[]}),true)
 assert.equal(steered.content[0].text,'背景也保持原样')
 finish.resolve();await pending
 assert.equal(sent.at(-1),'画好啦，看这次的表情。')
 assert.equal(runtime.channelReplyOwners.size,0)
 assert.equal(scope.ctx.tools.get('partner_chat_progress',agent),undefined)
 assert.equal(scope.ctx.tools.get('partner_chat_say',agent),undefined)
})

for(const deliveredKind of ['none','voice','attachment'])test(`a group work turn completes under 100 unrelated messages without extra turns (${deliveredKind})`,{timeout:10000},async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const session=Session.create('group-focus'),scope=createScope(root),started=deferred(),finish=deferred(),sent=[]
 const companion={id:'c',name:'伙伴'},peer='group:11223344:22334455'
 const channel={id:'qq',platform:'qq',accountId:'12345678',companionId:'c',enabled:true,direct:{baseUrl:'ws://unused',targetId:''},qq:{groupReplies:true,groupIds:['11223344'],autonomousGroupIds:['11223344']}}
 const route={id:'r',kind:'channel',channelId:'qq',userId:peer,companionId:'c',sessionId:session.id,qqSessionMode:'separate',inboundMessageIds:[],cwd:'/tmp'}
 const state={companions:[companion],channels:[channel],sessions:[route],pairings:[],recentReceipts:[]}
 const store={snapshot:()=>state,subscribe:()=>()=>{},update:async f=>{f(state);return state},isCompanionRemoving:()=>false}
 let work=Promise.resolve(),turns=0,steers=0,tools=0
 const agent={session,ctx:scope.ctx,status:'idle',inbox:{nextStep:[]},whenIdle:()=>work,inject:()=>{},steer:()=>{steers++}}
 const listeners=new Set()
 const ctx={tools:root.tools,on:(name,fn)=>{if(name==='session/event')listeners.add(fn);return ()=>listeners.delete(fn)},agents:{get:()=>agent},logger:{info(){},warn(){}}}
 const runtime=new PartnerAgentRuntime(ctx,store,'/tmp')
 runtime.ensureSession=async()=>route;runtime.ensureAgent=async()=>agent;runtime.cancelPostReply=async()=>{}
 runtime.persistInbound=async(_r,m)=>({query:m.text,content:[{type:'text',text:m.text}]})
 runtime.replyDelivered=async()=>{}
 const append=(type,data,opts)=>{session.append(type,data,opts);const e=session.snapshotEvents().at(-1);for(const fn of listeners)fn(session,e)}
 t.after(scope.ctx.tools.register({name:'generate_image',description:'test',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{tools++;return {ok:true}}}))
 agent.followup=m=>{
  turns++;agent.status='running';append('turn/start',{turn:1});append('user/message',m,{surfaceOp:'append'})
  work=(async()=>{
   // Only successful, correctly routed transport receipts close the unsent chat window.
   const receipt=(isError,originRouteId)=>({message:{id:'voice',role:'tool',source:{kind:'tool',callId:'voice'},toolCallId:'voice',isError,content:[]},meta:{kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'voice',originRouteId}})
   append('tool/result',receipt(true,route.id),{surfaceOp:'append'})
   // Probe the observer with a foreign receipt; it is not part of this conversation's replay.
   for(const listener of listeners)listener(session,{type:'tool/result',seq:session.seq,time:Date.now(),data:receipt(false,'other-route')})
   assert.equal(runtime.groupReplyFocus('qq',peer).sentAt,undefined)
   append('tool/call',{name:'generate_image',callId:'gen',arguments:'{}'})
   assert.equal(runtime.groupReplyFocus('qq',peer).working,true)
   started.resolve();await finish.promise
   const result=await dispatchTool(root.tools,{name:'generate_image',arguments:{},agent,callId:'gen',signal:new AbortController().signal})
   assert.equal(result.isError,false)
   append('tool/result',{message:{id:'out',role:'tool',source:{kind:'tool',callId:'gen'},toolCallId:'gen',content:[],isError:false}},{surfaceOp:'append'})
   if(deliveredKind==='voice')append('tool/result',receipt(false,route.id),{surfaceOp:'append'})
   if(deliveredKind==='attachment')append('tool/result',{message:{id:'attachment',role:'tool',source:{kind:'tool',callId:'attachment'},toolCallId:'attachment',isError:false,content:[]},meta:{kind:'partner-attachment-delivered-v1',originRouteId:route.id}},{surfaceOp:'append'})
   if(deliveredKind!=='none')assert.equal(typeof runtime.groupReplyFocus('qq',peer).sentAt,'number')
   append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'完成'}]}},{surfaceOp:'append'})
   append('turn/end',{turn:1,reason:{kind:'completed'}});agent.status='idle'
  })()
 }
 const manager=new ChannelManager({logger:ctx.logger},store,{},runtime,'/tmp')
 const api={config:channel.direct,sendText:async(_p,text)=>sent.push(text)}
 const event={id:'start',sender:peer,targetId:'group:11223344',text:'画个风景',qqGroup:{groupId:'11223344',userId:'22334455',senderName:'成员',mentioned:true,autonomous:true}}
 const pending=manager.handleDirect(channel,api,event,new AbortController().signal,[event],()=>{},'steer')
 await started.promise
 for(let i=0;i<100;i++){
  const e={...event,id:'flood-'+i,text:i%2?'他好像真去':'？',qqGroup:{...event.qqGroup,mentioned:false}}
  await manager.handleDirect(channel,api,e,new AbortController().signal,[e],()=>{},'steer')
 }
 assert.equal(steers,0);assert.equal(turns,1)
 finish.resolve();await pending
 assert.equal(tools,1);assert.equal(turns,1);assert.deepEqual(sent,deliveredKind==='voice'?[]:['完成'])
 assert.equal(runtime.groupReplyFocus('qq',peer),undefined);assert.equal(runtime.channelReplyFocus.size,0);assert.equal(listeners.size,0)
})
