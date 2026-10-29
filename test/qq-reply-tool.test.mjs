import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {qqReplyTool} from '../lib/channels/qq/reply-tool.js'
import {qqSettings} from '../lib/channels/qq/settings.js'

function fixture(privateChat=false){
 const session=Session.create('voice'),message=createUserMessage({content:[{type:'text',text:'用语音说你好'}],source:{kind:'user'}})
 session.append('user/message',message,{surfaceOp:'append'})
 const route={id:'r',kind:'channel',companionId:'c',sessionId:session.id,channelId:'qq',userId:privateChat?'22345678':'group:99887766:22345678',inboundMessageIds:[message.id]}
 const channel={id:'qq',companionId:'c',platform:'qq',enabled:true,updatedAt:1,qq:qqSettings({replyVoiceEnabled:true,replyVoiceGroupId:'99887766',groupReplies:true,groupIds:['99887766'],voiceCharacter:'test-voice'})}
 const state={sessions:[route],channels:[channel],pairings:[{channelId:'qq',userId:route.userId,status:'approved'}]}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>{const next=structuredClone(state);fn(next);Object.assign(state,next)}}
 const requests=[];let conclude=0
 const call=async(id,action,params,signal,guard)=>{guard();requests.push({id,action,params});if(action==='get_ai_record')return 'https://gchat.qpic.cn/voice/test.amr';if(action==='get_ai_characters')return [{characters:[{character_id:'test-voice',character_name:'测试音色'}]}];return {message_id:-23}}
 const exec={agent:{session},callId:'voice-1',signal:new AbortController().signal,concludeTurn:()=>conclude++}
 const tool=qqReplyTool('c',store,call)
 return {tool,exec,requests,state,concluded:()=>conclude,store,call}
}
test('guest group voice replies only to the current group without enabling private API powers',async()=>{
 const f=fixture();assert.equal(f.state.channels[0].qq.autonomousActions,false)
 const result=await f.tool.execute({action:'voice',text:'你好'},f.exec)
 assert.equal(result.status,'confirmed');assert.equal(f.concluded(),1)
 assert.deepEqual(f.requests[0].params,{group_id:99887766,character:'test-voice',text:'你好',chat_type:1})
 assert.equal(f.requests[0].action,'send_group_ai_record')
 await f.tool.execute({action:'voice',text:'重复'},f.exec);assert.equal(f.requests.length,1)
})
test('private voice uses synthesized media only and never sends to the source group',async()=>{
 const f=fixture(true)
 await f.tool.execute({action:'voice',text:'你好'},f.exec)
 assert.deepEqual(f.requests.map(x=>x.action),['get_ai_record','send_private_msg'])
 assert.equal(f.requests[1].params.user_id,22345678)
 assert.deepEqual(f.requests[1].params.message,[{type:'record',data:{file:'https://gchat.qpic.cn/voice/test.amr'}}])
 for(const args of [{action:'voice',text:'x',file:'/etc/passwd'},{action:'voice',text:'x',user_id:12345678},{action:'call',operation:'send_qzone_msg'}])await assert.rejects(f.tool.execute(args,f.exec))
})
test('chat voice revocation, unknown origins and off-switch fail before any API call',async()=>{
 for(const edit of [f=>f.state.channels[0].qq.replyVoiceEnabled=false,f=>f.state.pairings[0].status='blocked',f=>f.state.sessions[0].inboundMessageIds=[]]){
  const f=fixture();edit(f);await assert.rejects(f.tool.execute({action:'voice',text:'x'},f.exec));assert.equal(f.requests.length,0)
 }
})
test('generation cannot substitute local files or arbitrary external URLs; no duplicate send on uncertain results',async()=>{
 const f=fixture(true),tool=qqReplyTool('c',f.store,async(...args)=>{if(args[1]==='get_ai_record')return 'file:///etc/passwd';return f.call(...args)})
 await assert.rejects(tool.execute({action:'voice',text:'x'},f.exec))
 assert.equal(f.requests.length,0);assert.equal(f.state.channels[0].qqActivity[0].status,'unknown')
 const retry=await tool.execute({action:'voice',text:'x'},f.exec);assert.equal(retry.resent,false)
})
