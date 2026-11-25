import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import {chatTools} from '../lib/chat/tools.js'
import {requiresChatReplyReceipt} from '../lib/chat/protocol.js'
import {ReplyCompletionGuard,replyCompletionState} from '../lib/chat/reply-completion.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {prepareChannelReply} from '../lib/channels/outbound-media.js'
import {PushObserver} from '../lib/notifications/push-observer.js'
import {PartnerNoticeService} from '../lib/notifications/service.js'

function fixture(t){
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(ctx)
 const steered=[],agent={session:Session.create('speech-boundary'),options:{},steer:m=>steered.push(m)}
 const scope=createScope(ctx,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const card={enabled:true,segmentedReplies:true,stickersEnabled:false}
 const state={companions:[{id:'c',name:'伙伴',characterCard:card}],sessions:[{id:'r',kind:'channel',sessionId:agent.session.id,companionId:'c',channelId:'ch',userId:'peer',inboundMessageIds:[]}],channels:[{id:'ch',enabled:true,platform:'matrix'}],pairings:[{channelId:'ch',userId:'peer',status:'approved'}],pushChannels:[{companionId:'c',enabled:true}],schedules:[]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,subscribe:()=>()=>{}}
 t.after(scope.ctx.tools.register(chatTools('c',store,{},{},ctx,'/unused')[1]))
 agent.session.append('turn/start',{turn:1})
 const user=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'聊胜于无'}]})
 agent.session.append('user/message',user,{surfaceOp:'append'});state.sessions[0].inboundMessageIds.push(user.id)
 const answer=(text,extra=[])=>agent.session.append('assistant/message',{message:{role:'assistant',content:[{type:'reasoning',text:'private reasoning'},{type:'text',text},...extra]}},{surfaceOp:'append'})
 const guard=new ReplyCompletionGuard(agent,()=>true,()=>requiresChatReplyReceipt(card))
 const call=async(messages)=>{
  const args={messages},callId='chat-final'
  agent.session.append('tool/call',{callId,name:'partner_chat_reply',arguments:JSON.stringify(args)})
  const result=await dispatchTool(ctx.tools,{name:'partner_chat_reply',arguments:args,agent,callId,signal:new AbortController().signal})
  assert.equal(result.isError,false,JSON.stringify(result.content))
  agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'})
 }
 const end=()=>agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 return {agent,card,state,store,steered,guard,answer,call,end,events:()=>agent.session.snapshotEvents()}
}

test('unsubmitted model prose is withheld and recovered in the same input through the actual chat tool',async t=>{
 const f=fixture(t)
 f.answer('对方在说剩余额度。我准备接一句，再写拟回复。')
 assert.equal(replyCompletionState(f.events(),false,true).phase,'reply')
 assert.equal(channelReplyPartsAfter(f.events(),0,false,true).text,'')
 assert.deepEqual(channelReplyPartsAfter(f.events(),0,false,true).referenceTexts,[])
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 assert.equal(f.steered.length,1)
 assert.match(f.steered[0].content[0].text,/partner_chat_reply/)
 assert.match(f.guard.deny('bash',{command:'unexpected side effect'}),/不能重复或新增执行/)
 assert.equal(f.guard.deny('partner_chat_reply',{messages:[{text:'有一点也算赚了'}]}),undefined)
 // The model sees a notice in the same turn, rather than a replayed user input.
 f.agent.session.append('user/message',f.steered[0],{surfaceOp:'append'})
 await f.call([{text:'有一点也算赚了'}])
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 assert.equal(f.steered.length,1)
 assert.equal(f.guard.failed,false)
 f.end()
 const reply=await prepareChannelReply(channelReplyPartsAfter(f.events(),0,false,true),'/unused')
 assert.equal(reply.text,'有一点也算赚了')
 assert.deepEqual(reply.chatParts,[{type:'text',text:'有一点也算赚了'}])
 assert.equal(f.events().filter(e=>e.type==='user/message'&&e.data.source.kind==='user').length,1)
})

test('explicit chat mode uses submission evidence rather than guessing whether text sounds like thinking',t=>{
 for(const text of ['普通的一句回复','分析：应该先理解上下文','<think>内部草稿</think>','I will respond in character.']){
  const f=fixture(t);f.answer(text)
  assert.equal(replyCompletionState(f.events(),false,true).phase,'reply',text)
  assert.equal(channelReplyPartsAfter(f.events(),0,false,true).text,'')
 }
 assert.equal(requiresChatReplyReceipt({enabled:true,segmentedReplies:true}),true)
 assert.equal(requiresChatReplyReceipt({enabled:true,stickersEnabled:true}),true)
 for(const card of [undefined,{enabled:false,segmentedReplies:true},{enabled:true,segmentedReplies:false,stickersEnabled:false}])assert.equal(requiresChatReplyReceipt(card),false)
})

test('plain-text chat modes still accept ordinary final text without forcing a disabled chat tool',t=>{
 const f=fixture(t);f.card.segmentedReplies=false;f.answer('有一点也算赚了')
 assert.equal(replyCompletionState(f.events(),false,requiresChatReplyReceipt(f.card)).phase,'complete')
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 assert.equal(f.steered.length,0)
 f.end()
 assert.equal(channelReplyPartsAfter(f.events(),0,false,requiresChatReplyReceipt(f.card)).text,'有一点也算赚了')
})

test('exhausted or aborted correction never makes unsubmitted model prose eligible for sending',t=>{
 const f=fixture(t);f.answer('内部草稿，不是给群友的话')
 f.guard.stop({agent:f.agent,signal:AbortSignal.abort()});assert.equal(f.steered.length,0)
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 assert.throws(()=>f.guard.stop({agent:f.agent,signal:new AbortController().signal}))
 assert.equal(f.steered.length,2);assert.equal(f.guard.failed,true)
 f.end()
 assert.equal(channelReplyPartsAfter(f.events(),0,false,true).text,'')
})

test('completed work stays in settlement during speech correction and cannot execute again',async t=>{
 const f=fixture(t)
 f.agent.session.append('tool/call',{name:'send_email',arguments:'{}',callId:'mail'})
 f.agent.session.append('tool/result',{message:{toolCallId:'mail',content:[{type:'text',text:'{"sent":true}'}]}},{surfaceOp:'append'})
 f.answer('操作已经执行，接下来组织给用户的回复。')
 assert.equal(replyCompletionState(f.events(),false,true).phase,'settle')
 f.guard.stop({agent:f.agent,signal:new AbortController().signal})
 assert.match(f.guard.deny('send_email',{}),/不能重复/)
 await f.call([{text:'已经发好了'}]);f.end()
 assert.equal(channelReplyPartsAfter(f.events(),0,false,true).text,'已经发好了')
})

test('push and inbox notifications cannot bypass the explicit-chat sending boundary',async t=>{
 for(const submitted of [false,true]){
  const f=fixture(t),push=[],inbox=[]
  f.answer('内部分析与拟回复')
  if(submitted)await f.call([{text:'已经正式提交的话'}])
  const end=f.end()
  const observer=new PushObserver(f.store,{enqueue:async e=>push.push(e)},()=>assert.fail('push failed'))
  const notice=new PartnerNoticeService(f.store,{append:e=>inbox.push(e)},()=>assert.fail('inbox failed'))
  observer.observeSession(f.agent.session,end);notice.observeSession(f.agent.session,end)
  await observer.close();notice.close()
  assert.equal(push.length,submitted?1:0);assert.equal(inbox.length,submitted?1:0)
  if(submitted){assert.equal(push[0].text,'已经正式提交的话');assert.equal(inbox[0].summary,'已经正式提交的话')}
 }
})
