import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,pluginRecordOf} from '@deepseek-ai/dsh-session'
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {agentEvents} from '@deepseek-ai/dsh-agent'
import {recordInputOrigin} from '../lib/channels/input-origin.js'
import {recordNativeJobOrigin,nativeJobCompletion,nativeJobRoute,installNativeJobTurns} from '../lib/execution/native-job-origin.js'
import {questionOrigin} from '../lib/channels/question-origin.js'
import {ChannelManager} from '../lib/channels/manager.js'
import {chatTools} from '../lib/chat/tools.js'
import {qqSettings} from '../lib/channels/qq/settings.js'

function fixture(){
 const session=Session.create('native-jobs'),channel={id:'q',platform:'qq',companionId:'c',enabled:true,accountId:'bot',direct:{baseUrl:'ws://local',targetId:''},qq:qqSettings({groupReplies:true,groupIds:['12345678'],autonomousGroupIds:['12345678'],identityBinding:{enabled:true,qqIds:['22334455','33445566']}})}
 const a={id:'a',kind:'channel',sessionId:session.id,companionId:'c',channelId:'q',userId:'group:12345678:22334455',inboundMessageIds:[]}
 const b={...a,id:'b',userId:'group:12345678:33445566',inboundMessageIds:[]}
 const state={companions:[{id:'c',characterCard:{enabled:true,segmentedReplies:true,length:'normal'},capabilities:[]}],channels:[channel],sessions:[a,b],pairings:[],executionRuns:[],recentReceipts:[],notificationDeliveries:[]}
 const user=(route,text)=>{const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text}]});session.append('user/message',message,{surfaceOp:'append'});route.inboundMessageIds.push(message.id);recordInputOrigin(session,{messageId:message.id,routeId:route.id,channelId:route.channelId,userId:route.userId});return message}
 const register=(id,owner=session.id)=>{const event=session.append('job/registered',{jobId:id,owner,kind:'bash',label:'test job',startedAt:Date.now(),toolCall:{callId:'call',rootCallId:'call'}});recordNativeJobOrigin(session,event,state);return event}
 const notice=(id,source='tool-jobs')=>createUserMessage({source:{kind:source,form:'notice',summary:'bash completed'},content:[{type:'text',text:`background job ${id} (bash: test job) finished [status: completed]. Output:\nfile ready`}]})
 const appendNotice=id=>{const message=notice(id);session.append('user/message',message,{surfaceOp:'append'});return message}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>{fn(state);return state}}
 return {session,channel,a,b,state,user,register,notice,appendNotice,store}
}

test('native job completion resolves its original input and channel after another participant has spoken',()=>{
 const f=fixture();f.session.append('turn/start',{turn:1});const original=f.user(f.a,'下载文件');f.register('job-1');f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 f.session.append('turn/start',{turn:2});f.user(f.b,'另一个问题');f.session.append('turn/end',{turn:2,reason:{kind:'completed'}})
 f.session.append('turn/start',{turn:3});f.appendNotice('job-1')
 const job=nativeJobCompletion(f.session.id,f.session.snapshotEvents())
 assert.equal(job.input.data.id,original.id);assert.equal(job.origin.userId,f.a.userId)
 assert.equal(questionOrigin(f.session.id,f.session.snapshotEvents(),f.state.sessions).id,'a')
 assert.equal(nativeJobRoute(f.state,job.origin).id,'a')
 f.channel.accountId='changed';assert.equal(nativeJobRoute(f.state,job.origin),undefined)
 f.channel.accountId='bot';f.channel.enabled=false;assert.equal(nativeJobRoute(f.state,job.origin),undefined)
})

test('native job records cannot adopt a foreign, copied or unproven execution',()=>{
 const f=fixture();f.session.append('turn/start',{turn:1});f.user(f.a,'任务');f.register('foreign','someone-else')
 assert.equal(f.session.snapshotEvents().filter(event=>pluginRecordOf(event)?.type==='plugin:dsh-partner/native-job-origin').length,0)
 f.session.append('turn/end',{turn:1,reason:{kind:'completed'}});f.session.append('turn/start',{turn:2});f.appendNotice('foreign')
 assert.equal(nativeJobCompletion(f.session.id,f.session.snapshotEvents()),undefined)
 const spoof=f.notice('job-1','user');assert.equal(spoof.source.kind,'user')
})

test('new user inputs and completions for different routes are kept in separate native turns',async t=>{
 const f=fixture();f.session.append('turn/start',{turn:1});f.user(f.a,'任务 A');f.register('job-a');f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 f.session.append('turn/start',{turn:2});f.user(f.b,'任务 B');f.register('job-b');f.session.append('turn/end',{turn:2,reason:{kind:'completed'}})
 const root=new Context(),queued=[],agent={id:f.session.id,session:f.session,followup:message=>queued.push(message)}
 const scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose());t.after(installNativeJobTurns(root,()=>true))
 const decide=messages=>agentEvents(root,agent).waterfall('agent/pre-step',{turn:3,step:1,messages,modelSelection:{},signal:new AbortController().signal},async()=>({kind:'enter',messages}))
 const a=f.notice('job-a'),b=f.notice('job-b'),newInput=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'新问题'}]})
 assert.deepEqual((await decide([a,newInput])).messages,[newInput]);assert.deepEqual(queued,[a]);queued.length=0
 assert.deepEqual((await decide([a,b])).messages,[a]);assert.deepEqual(queued,[b])
})

test('native completion can use the normal reply tool and is delivered once to its frozen channel',async()=>{
 const f=fixture();f.session.append('turn/start',{turn:1});f.user(f.a,'下载文件');f.register('job-1');f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 f.session.append('turn/start',{turn:2});f.appendNotice('job-1')
 const tool=chatTools('c',f.store,{}, {}, {},'/api')[1]
 const agent={id:f.session.id,session:f.session,ctx:{},options:{}}
 let concluded=0
 const reply=await tool.execute({messages:[{text:'文件已经下好了'}],delivery:'text'},{agent,signal:new AbortController().signal,concludeTurn(){concluded++}})
 assert.equal(concluded,1);assert.equal(reply.originRouteId,'a')
 f.session.append('tool/result',{message:{toolCallId:'reply',isError:false,content:[]},meta:reply},{surfaceOp:'append'})
 f.session.append('assistant/message',{turn:2,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'文件已经下好了'}]}),stream:[]},{surfaceOp:'append'})
 const end=f.session.append('turn/end',{turn:2,reason:{kind:'completed'}})
 const sent=[],manager=new ChannelManager({},f.store,{}, {isArchived:()=>false},'/tmp')
 manager.queueProactive=async(route,receipt,payload,validate)=>{assert.equal(validate(),true);if(!sent.some(item=>item.receipt===receipt))sent.push({route,receipt,payload});return true}
 await manager.observeAutonomousResult(f.session,end);await manager.observeAutonomousResult(f.session,end)
 assert.equal(sent.length,1);assert.equal(sent[0].route.id,'a');assert.equal(sent[0].payload.directSource.accountId,'bot')
 assert.equal(sent[0].payload.text,'文件已经下好了')
 f.channel.direct.baseUrl='ws://changed';await assert.rejects(tool.execute({messages:[{text:'不应发送'}]},{agent,signal:new AbortController().signal,concludeTurn(){}}),/授权已变化/)
})

test('native jobs remain visible as busy while their owner agent is idle, and settled/foreign work is excluded',async()=>{
 const {nativeJobActivity}=await import('../lib/execution/native-job-origin.js')
 const f=fixture();f.session.append('turn/start',{turn:1});f.user(f.a,'任务');f.register('live')
 const jobs=[{id:'live',owner:f.session.id,status:'running'},{id:'done',owner:f.session.id,status:'completed'},{id:'foreign',owner:'other',status:'running'}]
 const ctx={get:()=>({list:owner=>{assert.equal(owner,f.session.id);return jobs}})}
 assert.equal(nativeJobActivity(ctx,f.session.id,()=>f.session.snapshotEvents()).length,1)
 assert.equal(nativeJobActivity(ctx,f.session.id,()=>f.session.snapshotEvents(),'q').length,1)
 assert.equal(nativeJobActivity(ctx,f.session.id,()=>f.session.snapshotEvents(),'other-channel').length,0)
 jobs[0].status='stopping';assert.equal(nativeJobActivity(ctx,f.session.id,()=>[]).length,1)
 jobs[0].status='killed';assert.equal(nativeJobActivity(ctx,f.session.id,()=>[]).length,0)
})
