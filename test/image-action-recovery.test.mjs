import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import {installLiveSpeech} from '../lib/chat/live-speech.js'
import {installTaskPreamble,failedTaskPreamble} from '../lib/execution/task-preamble.js'
import {ReplyCompletionGuard,replyCompletionState} from '../lib/chat/reply-completion.js'
import {chatTools} from '../lib/chat/tools.js'
async function fixture(t,names=['generate_image','partner_send_attachment']){
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(ctx)
 const agent={session:Session.create('image-recovery'),options:{},steer:m=>steered.push(m)},scope=createScope(ctx,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 const sent=[],executed=[],steered=[],state={companions:[{id:'c',characterCard:{enabled:true,roleText:'自定义人物',segmentedReplies:true}}],sessions:[{id:'r',kind:'channel',sessionId:agent.session.id,companionId:'c',channelId:'ch',userId:'peer',inboundMessageIds:[]}],channels:[{id:'ch',enabled:true,platform:'matrix'}],pairings:[{channelId:'ch',userId:'peer',status:'approved'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 t.after(installLiveSpeech(agent,async text=>{sent.push(text);executed.push('say')},()=> 'r'))
 t.after(installTaskPreamble(agent,async()=>assert.fail('no alternate sender'),()=>true,()=>true,true))
 for(const name of names)t.after(scope.ctx.tools.register({name,description:name,parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executed.push(name);return {ok:true}}}))
 t.after(scope.ctx.tools.register(chatTools('c',store,{},{},ctx,'/unused')[1]))
 const user=()=>{const m=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画个音乐家把蚊子当乐谱的漫画'}]});agent.session.append('user/message',m,{surfaceOp:'append'});state.sessions[0].inboundMessageIds.push(m.id)}
 agent.session.append('turn/start',{turn:1});user()
 let seq=0
 const call=async(name,args={})=>{
  const callId='image-'+seq++;agent.session.append('tool/call',{name,arguments:JSON.stringify(args),callId})
  const result=await dispatchTool(ctx.tools,{name,arguments:args,agent,signal:new AbortController().signal,callId})
  agent.session.append('tool/result',JSON.parse(JSON.stringify({message:{role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:result.content,isError:result.isError},meta:result.meta})),{surfaceOp:'append'});return result
 }
 return {agent,scope,sent,executed,steered,call,user}
}
test('registered image entry repairs preamble name before sending and executes original-turn work once',async t=>{
 const f=await fixture(t),args={text:'我来画，让音乐家跟那只蚊子较劲去',beforeTools:true,expectedTools:['image_gen.imagegen','partner_send_attachment']}
 const ack=await f.call('partner_chat_say',args);assert.equal(ack.isError,false,JSON.stringify(ack));assert.deepEqual(ack.meta.expectedTools,['generate_image','partner_send_attachment']);assert.match(JSON.stringify(ack.content),/generate_image/)
 assert.deepEqual(f.executed,['say']);assert.equal((await f.call('partner_chat_reply',{messages:[{text:'我来画'}]})).isError,true)
 const retry=await f.call('partner_chat_say',args);assert.equal(retry.isError,false);assert.deepEqual(retry.meta.expectedTools,['generate_image','partner_send_attachment']);assert.match(JSON.stringify(retry.content),/generate_image/);assert.equal(f.sent.length,1)
 assert.equal((await f.call('generate_image')).isError,false);assert.equal((await f.call('partner_send_attachment')).isError,false)
 const done=await f.call('partner_chat_reply',{messages:[{text:'这回音乐家可难住啦'}]});assert.equal(done.isError,false);assert.equal(done.concludesTurn,true)
 assert.deepEqual(f.executed,['say','generate_image','partner_send_attachment'])
})
test('failed action announcement cannot finish with a repeated promise; explicit honest non-execution can finish',async t=>{
 const f=await fixture(t,[])
 const rejected=await f.call('partner_chat_say',{text:'我来画',beforeTools:true,expectedTools:['image_gen.imagegen']});assert.equal(rejected.isError,true);assert.equal(f.sent.length,0);assert.equal(failedTaskPreamble(f.agent.session.snapshotEvents()),true)
 f.agent.session.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'我来画'}]}},{surfaceOp:'append'})
 assert.equal(replyCompletionState(f.agent.session.snapshotEvents()).phase,'execute')
 const guard=new ReplyCompletionGuard(f.agent,()=>true);guard.stop({agent:f.agent,signal:new AbortController().signal});assert.equal(f.steered.length,1);assert.equal(guard.deny('generate_image',{}),undefined)
 assert.equal((await f.call('partner_chat_reply',{messages:[{text:'我来画'}]})).isError,true)
 assert.equal((await f.call('partner_chat_reply',{messages:[{text:'被服务拒绝了'}],taskDisposition:'blocked',taskReason:'被拒绝',taskEvidence:{kind:'tool_error',excerpt:'safety system'}})).isError,true)
 const honest=await f.call('partner_chat_reply',{messages:[{text:'还没画出来，生图入口这会儿用不了'}],taskDisposition:'blocked',taskReason:'当前没有生图入口',taskEvidence:{kind:'not_executed'}});assert.equal(honest.isError,false);assert.equal(honest.concludesTurn,true)
 assert.equal(failedTaskPreamble(f.agent.session.snapshotEvents()),false);assert.deepEqual(f.executed,[])
})
test('an already registered image name is never substituted; new user input clears old failed preparation',async t=>{
 const f=await fixture(t,['generate_image','image_gen.imagegen'])
 const ack=await f.call('partner_chat_say',{text:'我来画',beforeTools:true,expectedTools:['image_gen.imagegen']});assert.deepEqual(ack.meta.expectedTools,['image_gen.imagegen'])
 const invalid=await f.call('partner_chat_say',{text:'再做点事',beforeTools:true,expectedTools:['not_a_tool']});assert.equal(invalid.isError,true);assert.equal(failedTaskPreamble(f.agent.session.snapshotEvents()),true)
 f.user();assert.equal(failedTaskPreamble(f.agent.session.snapshotEvents()),false)
})
