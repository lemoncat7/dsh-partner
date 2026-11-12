import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import {sendPreferredVoice,shortSpokenText} from '../lib/chat/preferred-voice.js'
import {installLiveSpeech} from '../lib/chat/live-speech.js'
import {installTaskPreamble,hasTaskPreamble} from '../lib/execution/task-preamble.js'
import {chatTools} from '../lib/chat/tools.js'
import {voiceReplyTool} from '../lib/voice/tool.js'
import {TtsService} from '../lib/voice/service.js'
import {chatReplyDefinition,nativeChatBlocks} from '../lib/chat/conversation.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
function wav(){const b=Buffer.alloc(244);b.write('RIFF');b.writeUInt32LE(236,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(200,40);return b}
async function fixture(t,options={}){
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(ctx)
 const agent={session:Session.create('preferred-voice'),options:{}},scope=createScope(ctx,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const sent=[],synth=[],state={companions:[{id:'c',toolDiscovery:true,characterCard:{enabled:true,roleText:'用户自定义人物',length:'short',shortVoiceReplies:true,segmentedReplies:true}}],sessions:[{id:'r',kind:'channel',sessionId:agent.session.id,companionId:'c',channelId:'ch',userId:'12345678',inboundMessageIds:[]}],channels:[{id:'ch',companionId:'c',enabled:true,updatedAt:1,platform:'qq',qq:{privateReplies:true}}],pairings:[{channelId:'ch',userId:'12345678',status:'approved'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)},dir=await mkdtemp(join(tmpdir(),'preferred-voice-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const keys=new Map(),service=new TtsService(store,{write:async(k,v)=>keys.set(k,v),read:async k=>keys.get(k)},dir,async(_url,init)=>{synth.push(JSON.parse(init.body));await options.generating?.(f);return new Response(wav(),{headers:{'content-type':'audio/wav'}})})
 const p=await service.save('c',{name:'test',provider:'breezeblue',endpoint:'https://example.test',voice:'selected-voice',model:'breeze-tts-2',language:'zh',speed:1,format:'wav',apiKey:'test'})
 await service.configure('ch',{enabled:true,profileId:p.id,voice:'',expectedUpdatedAt:1})
 const voice=voiceReplyTool('c',store,service,async(_id,action,params)=>{sent.push({action,params});await options.sent?.(f);if(options.unknown||sent.length===options.unknownAt)throw Error('timeout');return {message_id:sent.length}})
 t.after(installToolDiscovery(scope.ctx.tools,'c',store,[{tool:voice,allowed:()=>true}]))
 t.after(installLiveSpeech(agent,async text=>sent.push({text}),()=> 'r',()=>true,()=>true,undefined,undefined,(text,exec,opts)=>sendPreferredVoice('c',store,exec,[{text}],opts)))
 t.after(installTaskPreamble(agent,async()=>assert.fail('separate prelude'),()=>true,()=>true,true))
 t.after(scope.ctx.tools.register(chatTools('c',store,{},{},ctx,'/unused',options.adapters)[1]))
 t.after(scope.ctx.tools.register({name:'generate_image',description:'image',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({ok:true})}))
 const user=()=>{const m=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画个漫画'}]});agent.session.append('user/message',m,{surfaceOp:'append'});state.sessions[0].inboundMessageIds.push(m.id)}
 agent.session.append('turn/start',{turn:1});user()
 let seq=0
 const call=async(name,args={})=>{const callId='voice-'+seq++;agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId});const result=await dispatchTool(ctx.tools,{name,arguments:args,agent,signal:new AbortController().signal,callId});agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result}
 const f={agent,scope,store,state,sent,synth,call,user};return f
}
function useGroup(f){
 f.state.sessions[0].userId='group:99887766:12345678'
 Object.assign(f.state.channels[0].qq,{groupReplies:true,groupIds:['99887766'],autonomousGroupIds:['99887766']})
 f.state.pairings[0].userId=f.state.sessions[0].userId
}
for(const delivery of [undefined,'auto','voice'])test('group chat excludes automatic voice but preserves explicit voice: '+delivery,async t=>{
 const f=await fixture(t);useGroup(f)
 const r=await f.call('partner_chat_reply',{messages:[{text:'好呀'},{text:'我也觉得'}],...(delivery?{delivery}:{})})
 assert.equal(r.isError,false,JSON.stringify(r))
 if(delivery==='voice'){
  assert.equal(f.synth.length,2);assert.equal(f.sent.length,2)
  assert.equal(f.sent[0].action,'send_group_msg');assert.equal(f.sent[0].params.group_id,99887766)
 }else{
  assert.equal(f.synth.length,0);assert.equal(f.sent.length,0)
  assert.deepEqual(r.meta.parts.map(p=>p.text),['好呀','我也觉得'])
 }
})
test('autonomous group activity also excludes automatic voice',async t=>{
 const f=await fixture(t);useGroup(f)
 const message=createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[]})
 f.agent.session.append('user/message',message,{surfaceOp:'append'})
 f.state.sessions[0].idleContactState={messageId:message.id}
 const r=await sendPreferredVoice('c',f.store,{agent:f.agent,callId:'idle',signal:new AbortController().signal},[{text:'刚才想到个好玩的'}])
 assert.equal(r,undefined);assert.equal(f.synth.length,0);assert.equal(f.sent.length,0)
})
for(const mixed of [false,true])test('voice preference preserves selected QQ image stickers: '+mixed,async t=>{
 const native={provider:'qq-custom',id:'test-face',channelId:'ch',accountId:'87654321',label:'收藏图片'}
 const adapters={forRoute:()=>({resolve:async(_owner,id)=>({item:{id,name:'收藏图片'},native})})}
 const f=await fixture(t,{adapters});f.state.companions[0].characterCard.stickersEnabled=true
 const messages=[...(mixed?[{text:'这个很像刚才那个'}]:[]),{stickerId:'qq-custom-test'}]
 const r=await f.call('partner_chat_reply',{messages})
 assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.concludesTurn,true)
 assert.equal(f.synth.length,0);assert.equal(f.sent.length,0)
 assert.deepEqual(r.meta.parts.map(p=>p.type),mixed?['text','emoji']:['emoji'])
 assert.equal(r.meta.parts.at(-1).emoji.provider,'qq-custom')
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const delivery=channelReplyPartsAfter(f.agent.session.snapshotEvents(),0)
 assert.equal(delivery.chatParts.at(-1).emoji.id,'test-face')
})
test('speech eligibility preserves prose, keeps long/structured/mixed content as text',()=>{
 assert.equal(shortSpokenText([{text:'我去画啦'}]),'我去画啦')
 assert.equal(shortSpokenText([{text:'我去画啦'},{text:'等我一下'}]),undefined)
 for(const parts of [[{text:'字'.repeat(81)}],[{text:'看 https://example.test'}],[{text:'第一行\n第二行'}],[{text:'你好'},{stickerId:'s'}],[{text:'1. 标题'}],[{text:'/home/user/a.png'}],[]])assert.equal(shortSpokenText(parts),undefined)
})
test('task prelude voices exact authored text before work; final voice concludes once without duplicate projection/delivery',async t=>{
 const f=await fixture(t),args={text:'我去画啦，等我一下',beforeTools:true,expectedTools:['generate_image']}
 const ack=await f.call('partner_chat_say',args);assert.equal(ack.isError,false,JSON.stringify(ack));assert.equal(ack.meta.deliveryKind,'voice');assert.equal(ack.concludesTurn,undefined);assert.equal(hasTaskPreamble(f.agent.session.snapshotEvents()),true)
 assert.equal(f.synth[0].text,args.text);assert.equal(f.sent[0].params.message[0].type,'record');assert.equal(f.sent[0].params.user_id,12345678)
 await f.call('partner_chat_say',args);assert.equal(f.sent.length,1)
 assert.equal((await f.call('generate_image')).isError,false)
 const done=await f.call('partner_chat_reply',{messages:[{text:'画好啦'}]});assert.equal(done.isError,false,JSON.stringify(done));assert.equal(done.concludesTurn,true);assert.equal(done.meta.deliveryKind,'voice');assert.equal(done.meta.intermediate,false);assert.equal(f.sent.length,2)
 const child=f.agent.session.snapshotEvents().filter(e=>e.type==='tool/ptc-dispatch').at(-1)
 assert.match(nativeChatBlocks(child.data.meta)[0].text,/语音已发送/)
 assert.equal(chatReplyDefinition.buildViewNode({state:done.meta,start:{event:child,location:{}}}),null)
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const delivery=channelReplyPartsAfter(f.agent.session.snapshotEvents(),0);assert.equal(delivery.alreadyDelivered,true);assert.deepEqual(delivery.chatParts,[])
})
for(const reason of ['explicit-text','literal','long','off','channel-off','local','details'])test('text fallback keeps authored content: '+reason,async t=>{
 const f=await fixture(t),args={messages:[{text:'好呀'}]}
 if(reason==='explicit-text')args.delivery='text'
 if(reason==='literal')args.preserveText=true
 if(reason==='long')args.messages[0].text='字'.repeat(81)
 if(reason==='off')f.state.companions[0].characterCard.shortVoiceReplies=false
 if(reason==='channel-off')f.state.channels[0].tts.enabled=false
 if(reason==='local'){f.state.sessions[0].kind='local';delete f.state.sessions[0].channelId}
 if(reason==='details')args.inlineDetails=true
 const r=await f.call('partner_chat_reply',args);assert.equal(r.isError,false,JSON.stringify(r));assert.equal(f.sent.length,0);assert.equal(f.synth.length,0);assert.equal(r.meta.parts[0].text,args.messages[0].text)
})
test('unknown voice send does not fall back to text, regenerate, end turn or release work',async t=>{
 const f=await fixture(t,{unknown:true}),a={text:'我去画啦',beforeTools:true,expectedTools:['generate_image']}
 assert.equal((await f.call('partner_chat_say',a)).isError,true)
 assert.equal(hasTaskPreamble(f.agent.session.snapshotEvents()),false)
 assert.equal((await f.call('partner_chat_say',a)).isError,true);assert.equal(f.sent.length,1);assert.equal(f.synth.length,1)
 assert.equal((await f.call('generate_image')).isError,true)
})
for(const reason of ['new-input','revocation'])test('voice generation rechecks source and authorization: '+reason,async t=>{
 const f=await fixture(t,{generating:async f=>{if(reason==='new-input')f.user();else f.state.channels[0].enabled=false}})
 const r=await f.call('partner_chat_reply',{messages:[{text:'好呀'}]});assert.equal(r.isError,true);assert.equal(f.sent.length,0);assert.ok(!r.concludesTurn)
})
test('nested voice honors tool permission pipeline',async t=>{
 const f=await fixture(t);t.after(f.scope.ctx.tools.guard(exec=>exec.name==='partner_voice_reply'?'test denial':undefined))
 const r=await f.call('partner_chat_reply',{messages:[{text:'好呀'}]});assert.equal(r.isError,true);assert.equal(f.synth.length,0);assert.equal(f.sent.length,0)
})


test('one final reply sends distinct short voice messages without merging or duplicate parent projection',async t=>{
 const f=await fixture(t),messages=[{text:'我发现个好玩的'},{text:'刚才那只猫偷偷往后退'},{text:'还以为没人看见呢'}]
 const r=await f.call('partner_chat_reply',{messages})
 assert.equal(r.isError,false,JSON.stringify(r));assert.equal(f.sent.length,3);assert.equal(f.synth.length,3)
 assert.equal(r.concludesTurn,true)
 assert.equal(r.meta.spokenText,messages.map(p=>p.text).join('\n'))
 assert.equal(r.meta.deliveryKind,'voice');assert.ok(r.meta.transportCallId.endsWith(':reply-voice:3'))
 assert.deepEqual(f.synth.map(s=>s.text),messages.map(p=>p.text))
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 const delivery=channelReplyPartsAfter(f.agent.session.snapshotEvents(),0)
 assert.equal(delivery.alreadyDelivered,true);assert.deepEqual(delivery.chatParts,[])
})

test('new user input between short voice parts interrupts remaining messages',async t=>{
 const f=await fixture(t,{generating:async f=>{if(f.synth.length===2)f.user()}})
 const r=await f.call('partner_chat_reply',{messages:[{text:'第一句话'},{text:'第二句话'},{text:'第三句话'}]})
 assert.equal(r.isError,true);assert.equal(f.sent.length,1);assert.equal(f.synth.length,2);assert.ok(!r.concludesTurn)
})

test('multiple voice continuations remain in the same turn and final reply closes it',async t=>{
 const f=await fixture(t)
 const a=await f.call('partner_chat_say',{text:'我刚才想到个好玩的'})
 const b=await f.call('partner_chat_reply',{messages:[{text:'猫明明看见了'},{text:'它偏偏装没看见'}],continueTurn:true})
 const c=await f.call('partner_chat_reply',{messages:[]})
 assert.equal(a.isError,false);assert.ok(!a.concludesTurn);assert.equal(b.isError,false);assert.ok(!b.concludesTurn)
 assert.equal(c.isError,false);assert.equal(c.concludesTurn,true);assert.equal(f.sent.length,3)
})


test('new input after the first receipt stops before generating the next voice',async t=>{
 const f=await fixture(t,{sent:async f=>{if(f.sent.length===1)f.user()}})
 const r=await f.call('partner_chat_reply',{messages:[{text:'第一句'},{text:'第二句'}]})
 assert.equal(r.isError,true);assert.equal(f.sent.length,1);assert.equal(f.synth.length,1);assert.ok(!r.concludesTurn)
})

test('unknown second voice stops the batch without resending confirmed first part or falling back',async t=>{
 const f=await fixture(t,{unknownAt:2})
 const r=await f.call('partner_chat_reply',{messages:[{text:'第一句'},{text:'第二句'},{text:'第三句'}]})
 assert.equal(r.isError,true);assert.equal(f.sent.length,2);assert.equal(f.synth.length,2);assert.ok(!r.concludesTurn)
 assert.ok(r.content.some(b=>b.type==='text'&&b.text.includes('已确认发送 1 条')))
})


test('task correction is checked before any speech; discussion can stop and later chat is free',async t=>{
 const f=await fixture(t)
 const old=f.agent.session.snapshotEvents().find(e=>e.type==='user/message').data.id
 await f.call('partner_chat_say',{text:'我来画',beforeTools:true,expectedTools:['generate_image']})
 await f.call('generate_image');await f.call('partner_chat_reply',{messages:[{text:'画好了'}]})
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}});f.agent.session.append('turn/start',{turn:2});f.user()
 const before=f.sent.length
 const wrong=await f.call('partner_chat_reply',{messages:[{text:'对，应该先理解再做'}]})
 assert.equal(wrong.isError,true);assert.equal(f.sent.length,before);assert.ok(!wrong.concludesTurn)
 const rawVoice=await f.call('partner_tools',{action:'call',name:'partner_voice_reply',argumentsJson:JSON.stringify({action:'speak',text:'对，你说得对'})})
 assert.match(JSON.stringify(rawVoice),/taskReview/);assert.equal(f.sent.length,before)
 const done=await f.call('partner_chat_reply',{messages:[{text:'这次只聊怎么做'}],taskReview:{taskInputId:old,kind:'unrelated',reason:'当前用户已经换话题'}})
 assert.equal(done.isError,false,JSON.stringify(done));assert.equal(done.meta.taskReview.kind,'unrelated');assert.equal(f.sent.length,before+1)
 f.agent.session.append('turn/end',{turn:2,reason:{kind:'completed'}});f.agent.session.append('turn/start',{turn:3});f.user()
 assert.equal((await f.call('partner_chat_reply',{messages:[{text:'好呀'}]})).isError,false)
})
