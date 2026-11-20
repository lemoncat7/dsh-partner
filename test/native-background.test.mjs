import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertObjectJsonSchema} from '@deepseek-ai/dsh-tools'
import {NativeBackgroundTasks,PARTNER_BACKGROUND_PROVIDER} from '../lib/execution/native-background.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
import {markObservationAgent} from '../lib/observation-contract.js'
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
async function fixture(t,preferences,images){
 const cwd=await mkdtemp(join(tmpdir(),'partner-native-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const channel={id:'q',platform:'qq',accountId:'bot',companionId:'c',enabled:true,direct:{baseUrl:'ws://local',targetId:''},qq:qqSettings({groupReplies:true,groupIds:['12345678'],autonomousGroupIds:['12345678'],identityBinding:{enabled:true,qqIds:['22334455']}})}
 const event=id=>({type:'user/message',data:{id,source:{kind:'user'},content:[{type:'text',text:'整理当前 /tmp/reference.md，生成配图'}]}})
 let events=[event('input')]
 const parent={session:{id:'parent',header:{cwd},snapshotEvents:()=>events},ctx:{tools:{definitions:()=>[]}}}
 const route={id:'route',kind:'channel',sessionId:'parent',companionId:'c',channelId:'q',userId:'group:12345678:22334455',inboundMessageIds:['input','update']}
 const state={channels:[channel],companions:[{id:'c',capabilities:['work'],characterCard:{enabled:true}}],sessions:[route],pairings:[],executionRuns:[]}
 const subscribers=new Set(),guards=[],calls=[],sent=[],updates=[],resumes=[],resumeResult=deferred(),result=deferred();let disposed=0
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},update:async fn=>{fn(state);for(const listener of subscribers)listener();return structuredClone(state)}}
 const native={getProvider:()=>PARTNER_BACKGROUND_PROVIDER,registerProvider:()=>()=>{},startActivation:async spec=>{calls.push(spec);return {childId:spec.childId,name:'agent-1',result:result.promise,dispose:async()=>{disposed++}}},resumeActivation:async spec=>{resumes.push(spec);return {childId:spec.childId,name:'agent-1',result:resumeResult.promise,dispose:async()=>{disposed++}}},sendMessage:async(...args)=>updates.push(args)}
 const handlers=new Map()
 const ctx={get:()=>native,on:(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name)},tools:{guard:fn=>{guards.push(fn);return()=>guards.splice(guards.indexOf(fn),1)}},logger:{warn(){}}},deliver=async(run,reply)=>sent.push({run:structuredClone(run),reply})
 const service=new NativeBackgroundTasks(ctx,store,deliver,preferences,undefined,images)
 t.after(()=>service.close())
 const tool=service.tool('c'),exec={agent:parent,signal:new AbortController().signal}
 const start=()=>tool.execute({action:'start',label:'整理',input:'目标：整理 /tmp/reference.md 并生成配图'},exec)
 return {state,parent,route,store,service,tool,exec,start,calls,sent,updates,result,guards,ctx,deliver,native,resumes,resumeResult,handlers,disposed:()=>disposed,setEvents:v=>{events=v},event}
}
const waitFor=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('completion did not settle')}
test('native acceptance returns immediately; ordinary chat does not cancel and result keeps original group',async t=>{
 const f=await fixture(t),accepted=await f.start();assert.equal(accepted.status,'running');assert.equal(f.sent.length,0)
 assertObjectJsonSchema(f.calls[0].outputSchema);assert.equal(f.calls[0].delivery,'caller');assert.equal(f.calls[0].provider,'partner-task');assert.match(f.calls[0].prompt[0].text,/reference.md/)
 assert.equal((await f.start()).alreadyAccepted,true);assert.equal(f.calls.length,1)
 f.route.inboundMessageIds=Array.from({length:128},(_,i)=>'later-'+i)
 f.setEvents([f.event('other')]);f.state.sessions.push({...f.route,id:'other',userId:'group:12345678:99887766',inboundMessageIds:['other']});await f.store.update(()=>{})
 assert.equal(f.disposed(),0)
 f.result.resolve({stopReason:'completed',structured:{text:'整理完成',files:[]}})
 await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 assert.equal(f.sent[0].run.background.userId,'group:12345678:22334455');assert.equal(f.sent.length,1)
 await f.service.recoverDeliveries();assert.equal(f.sent.length,1)
})
test('revocation disposes activation; child cannot send directly or nest forbidden calls',async t=>{
 const f=await fixture(t),a=await f.start(),guard=f.guards[0],agent={session:{id:a.childSessionId}}
 assert.match(guard({agent,name:'partner_chat_reply',arguments:{}}),/不直接聊天/)
 assert.match(guard({agent,name:'partner_tools',arguments:{action:'call',name:'partner_identity',argumentsJson:'{}'}}),/不直接聊天/)
 assert.equal(guard({agent,name:'web_search',arguments:{query:'work'}}),undefined)
 f.state.channels[0].qq.identityBinding={enabled:true,qqIds:['99887766']};await f.store.update(()=>{});assert.equal(f.disposed(),1)
 assert.match(guard({agent,name:'web_search',arguments:{}}),/授权/)
})
test('only original source can update or cancel, accepted update leaves completed actions intact',async t=>{
 const f=await fixture(t),a=await f.start();f.setEvents([f.event('update')])
 await f.tool.execute({action:'update',taskId:a.taskId,input:'改为横版'},f.exec);assert.equal(f.updates.length,1)
 f.setEvents([f.event('other')]);f.state.sessions.push({...f.route,id:'other',userId:'group:12345678:99887766',inboundMessageIds:['other']})
 await assert.rejects(f.tool.execute({action:'cancel',taskId:a.taskId},f.exec),/发起人操作/)
 f.setEvents([f.event('update')]);await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec);assert.equal(f.state.executionRuns[0].status,'canceled');assert.equal(f.disposed(),1)
 f.result.resolve({stopReason:'completed',structured:{text:'旧结果',files:[]}});await new Promise(r=>setTimeout(r,10));assert.equal(f.sent.length,0)
})
test('native task selection follows the live DSH subagent setting at start and at cold resume',async t=>{
 const f=await fixture(t),configured={enabled:true,allowedModels:[{provider:'openai',model:'gpt-6.2-sol'}]}
 const get=f.ctx.get
 f.ctx.get=name=>name==='subagentModelSelection'?{current:()=>configured}:get(name)
 const first=await f.start()
 assert.deepEqual(f.calls[0].agentOptions,configured.allowedModels[0])
 await f.tool.execute({action:'pause',taskId:first.taskId},f.exec)
 configured.allowedModels=[{provider:'openai',model:'next-choice'}]
 const selections=[]
 const resume=f.native.resumeActivation
 f.native.resumeActivation=async spec=>{
  await f.handlers.get('agent/created')({agent:{
   session:{id:spec.childId},model:{select:selection=>selections.push(selection)},
   ctx:{systemPrompt:{section:()=>()=>{}},tools:{register:()=>()=>{},presentAs:()=>()=>{}}}
  }})
  return resume(spec)
 }
 f.setEvents([f.event('update')])
 const resumed=await f.tool.execute({action:'resume',taskId:first.taskId},f.exec)
 assert.equal(resumed.childSessionId,first.childSessionId)
 assert.deepEqual(selections,configured.allowedModels)
 assert.equal(f.calls.length,1)
 configured.enabled=false
 f.route.inboundMessageIds.push('new')
 const fresh=f.event('new');fresh.data.content=[{type:'text',text:'另外开独立任务'}];f.setEvents([fresh])
 await f.tool.execute({action:'start',label:'独立任务',input:'新工作'},f.exec)
 assert.equal(f.calls[1].agentOptions,undefined)
})
test('QQ group tasks share visibility and reuse identical or compatible requests from another member',async t=>{
 const f=await fixture(t)
 f.state.channels[0].qq.identityBinding={enabled:false,qqIds:[]}
 const first=await f.start()
 const peer={...f.route,id:'peer',userId:'group:12345678:99887766',inboundMessageIds:['peer-input','peer-correction']}
 f.state.sessions.push(peer)
 f.setEvents([f.event('peer-input')])
 const duplicate=await f.start()
 assert.equal(duplicate.taskId,first.taskId);assert.equal(f.calls.length,1);assert.equal(f.updates.length,0)
 const correction=f.event('peer-correction');correction.data.content=[{type:'text',text:'补充刚才那项，把配图改成横版'}];f.setEvents([correction])
 const updated=await f.tool.execute({action:'start',label:'整理',input:'整理当前 /tmp/reference.md，配图改成横版'},f.exec)
 assert.equal(updated.taskId,first.taskId);assert.equal(updated.updated,true);assert.equal(f.updates.length,1)
 f.state.executionRuns[0].outputSummary='原流程的内部信息'
 f.state.executionRuns[0].error='内部文件路径'
 const status=await f.tool.execute({action:'status',taskId:first.taskId},f.exec)
 assert.equal(status.status,'running');assert.equal(status.output,undefined);assert.equal(status.error,undefined)
 f.state.executionRuns.push(...Array.from({length:13},(_,i)=>({...structuredClone(f.state.executionRuns[0]),id:'old'+i,status:'completed'})))
 for(const userId of ['99887766','group:99887766:99887766']){
  f.state.sessions.push({...peer,id:userId,userId,inboundMessageIds:['foreign-'+userId]})
 }
 f.state.channels[0].qq.privateReplies=true
 f.state.channels[0].qq.groupIds.push('99887766');f.state.channels[0].qq.autonomousGroupIds.push('99887766')
 f.state.pairings.push({channelId:'q',userId:'99887766',status:'approved'})
 assert.equal((await f.tool.execute({action:'list'},f.exec)).tasks[0].taskId,first.taskId)
 for(const userId of ['99887766','group:99887766:99887766']){
  f.setEvents([f.event('foreign-'+userId)])
  assert.deepEqual((await f.tool.execute({action:'list'},f.exec)).tasks,[])
 }
})
test('QQ group members can see an owner task but cannot steer its elevated tools',async t=>{
 const f=await fixture(t),first=await f.start()
 f.state.sessions.push({...f.route,id:'peer',userId:'group:12345678:99887766',inboundMessageIds:['peer']})
 f.setEvents([f.event('peer')])
 assert.deepEqual((await f.tool.execute({action:'list'},f.exec)).tasks.map(r=>r.taskId),[first.taskId])
 await assert.rejects(f.tool.execute({action:'update',taskId:first.taskId,input:'补充新的操作'},f.exec),/工具范围/)
 assert.equal(f.updates.length,0)
})
test('invalid outputs and escaped artifacts fail without sending; restart retries only saved completion',async t=>{
 const f=await fixture(t);await f.start();const outside=join(tmpdir(),'outside.txt')
 f.result.resolve({stopReason:'completed',structured:{text:'成果',files:[{path:outside,name:'x',mediaType:'text/plain'}]}})
 await waitFor(()=>f.state.executionRuns[0].status==='failed');assert.equal(f.sent.length,0)
 f.state.executionRuns[0].status='completed';f.state.executionRuns[0].background.result={text:'保存结果',files:[]}
 await f.service.recoverDeliveries();assert.equal(f.sent.length,1);assert.equal(f.calls.length,1)
})

test('official rc.2 fork contract excludes the in-flight user request, which adapter supplies explicitly',async()=>{
 const {apply}=await import('@deepseek-ai/dsh-subagent-fork-in-process')
 let provider;apply({subagents:{registerProvider:p=>{provider=p}}},{providerName:'fork'})
 assert.equal(provider.name,'fork');assert.equal(provider.capabilities.outputSchema,true);assert.equal(provider.capabilities.depthLimit,true)
 const completed=[{seq:0,type:'user/message',data:{id:'old'}},{seq:1,type:'turn/end',data:{}}]
 const current={seq:2,type:'user/message',data:{id:'current'}}
 const prepared=await provider.prepareContinuable({parent:{session:{snapshotEvents:()=>[...completed,current]}}})
 assert.deepEqual(prepared.seed,completed)
})

test('private QQ tasks use native background and return to the same private route',async t=>{
 const f=await fixture(t);f.route.userId='22334455';f.state.channels[0].qq.privateReplies=true
 f.state.pairings.push({channelId:'q',userId:'22334455',status:'approved',directTargetId:'22334455'})
 const accepted=await f.start();assert.equal(accepted.status,'running');assert.equal(f.calls.length,1)
 assert.equal(f.state.executionRuns[0].background.targetId,'22334455')
 await writeFile(join(f.calls[0].cwd,'image.png'),Buffer.from([137,80,78,71]))
 f.result.resolve({stopReason:'completed',structured:{text:'图片已生成',files:[{path:'image.png',name:'image.png',mediaType:'image/png'}]}})
 await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 assert.equal(f.sent[0].run.background.userId,'22334455');assert.equal(f.sent.length,1)
 assert.equal(f.sent[0].reply.attachments[0].mediaType,'image/png');assert.equal(f.sent[0].reply.attachments.length,1,'image delivery does not need an extra report')
 assert.match(f.guards[0]({...f.exec,name:'generate_image',arguments:{}}),/必须先/)
})
test('foreground image dispatch is refused before work; child and unrelated sessions retain their policy',async t=>{
 const f=await fixture(t),guard=f.guards[0]
 assert.match(guard({...f.exec,name:'generate_image',arguments:{}}),/必须先/)
 assert.match(guard({...f.exec,name:'partner_tools',arguments:{action:'call',name:'generate_image',argumentsJson:'{}'}}),/必须先/)
 assert.equal(guard({...f.exec,name:'web_search',arguments:{}}),undefined)
 const a=await f.start();assert.equal(guard({agent:{session:{id:a.childSessionId}},name:'generate_image',arguments:{}}),undefined)
 assert.equal(guard({agent:{session:{id:'local',snapshotEvents:()=>[]}},name:'generate_image',arguments:{}}),undefined)
 f.state.channels[0].qq.identityBinding={enabled:true,qqIds:['99887766']}
 assert.match(guard({...f.exec,name:'generate_image',arguments:{}}),/必须先/)
})
test('unapproved private routes cannot start work',async t=>{
 const f=await fixture(t);f.route.userId='22334455';f.state.channels[0].qq.privateReplies=true
 await assert.rejects(f.start(),/授权/);assert.equal(f.calls.length,0)
})

test('independent concern checks do not hit foreground delegation for the same session',async t=>{
 const f=await fixture(t),guard=f.guards[0]
 const work={...f.exec,name:'bash',arguments:{command:'dsh -V'}}
 assert.match(guard(work),/必须先/)
 const observation={...f.parent}
 const release=markObservationAgent(observation)
 try{
  assert.equal(guard({...work,agent:observation}),undefined)
  assert.match(guard(work),/必须先/)
 }finally{release()}
 assert.match(guard({...work,agent:observation}),/必须先/)
})

test('all local companions can use native background without a channel or foreground constraints',async t=>{
 const f=await fixture(t);f.route.kind='local';f.route.channelId='@local';f.route.userId='owner:c';f.state.channels=[]
 const a=await f.start();assert.equal(a.status,'running');assert.equal(f.state.executionRuns[0].background.sourceKind,'local')
 assert.equal(f.calls[0].prompt[0].text,'目标：整理 /tmp/reference.md 并生成配图')
 assert.doesNotMatch(f.calls[0].prompt[0].text,/text 按当前伙伴人格/)
 const text='完整调查结论和未确认事项\n'.repeat(300)
 f.result.resolve({stopReason:'completed',structured:{text,files:[]}})
 await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 assert.equal(f.sent[0].run.background.result.text,text)
 assert.deepEqual(f.sent[0].reply.attachments,[],'a long internal result alone must not manufacture a report')
 const {readdir}=await import('node:fs/promises')
 assert.ok(!(await readdir(f.calls[0].cwd)).some(name=>name.startsWith('execution-result-')))
 assert.equal(f.sent.length,1)
})
test('non-QQ approved channels retain their native source authorization',async t=>{
 const f=await fixture(t);f.state.channels[0].platform='matrix';f.route.userId='alice';f.state.pairings.push({channelId:'q',userId:'alice',status:'approved',directTargetId:'room'})
 const a=await f.start();assert.equal(a.status,'running');assert.equal(f.state.executionRuns[0].background.targetId,'room')
 f.result.resolve({stopReason:'completed',structured:{text:'已核验',files:[]}})
 await waitFor(()=>f.sent.length===1);assert.equal(f.sent[0].run.background.channelId,'q')
})

test('conversational tool guard avoids history snapshots and state copies',async t=>{
 const f=await fixture(t),agent={session:{id:'parent',snapshotEvents(){assert.fail('chat should not rescan history')}}}
 assert.equal(f.guards[0]({agent,name:'partner_chat_reply',arguments:{messages:[{text:'好'}]}}),undefined)
 assert.equal(f.guards[0]({agent,name:'partner_tools',arguments:{action:'describe',name:'partner_browser'}}),undefined)
})

test('fresh partner backend never reads or seeds parent history',async()=>{assert.equal(PARTNER_BACKGROUND_PROVIDER.inheritsParentContext,false);assert.deepEqual(await PARTNER_BACKGROUND_PROVIDER.prepareContinuable({parent:{session:{snapshotEvents(){assert.fail('must not read parent history')}}}}),{})})

test('accepted work ends the foreground after confirmed preamble, without another model reply',async t=>{
 const f=await fixture(t);let ended=0;f.exec.concludeTurn=()=>{ended++}
 f.setEvents([f.event('input'),{type:'tool/result',data:{message:{toolCallId:'say',content:[]},meta:{kind:'partner-chat-v1',parts:[{type:'text',text:'我去找'}],delivered:true,taskPreamble:true,inputMessageId:'input'}}}])
 await f.start();assert.equal(ended,1)
 assert.equal(f.calls[0].prompt.length,1);assert.equal(f.calls[0].prompt[0].text,'目标：整理 /tmp/reference.md 并生成配图')
 assert.doesNotMatch(f.calls[0].prompt[0].text,/原始输入|本轮已执行|继承历史/)
})

test('existing artifacts inside authorized original directory are copied and preserved',async t=>{
 const f=await fixture(t);await f.start();const original=join(f.parent.session.header.cwd,'walk.gif');await writeFile(original,'GIF89a')
 f.result.resolve({stopReason:'completed',structured:{text:'找到第七版',files:[{path:original,name:'walk.gif',mediaType:'image/gif'}]}})
 await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 const {readFile}=await import('node:fs/promises'),copy=f.sent[0].reply.attachments[0].path
 assert.notEqual(copy,original);assert.ok(copy.startsWith(f.calls[0].cwd+'/artifacts/'));assert.equal(await readFile(copy,'utf8'),'GIF89a');assert.equal(await readFile(original,'utf8'),'GIF89a')
})
test('failed artifact validation recovers saved final output without rerunning work',async t=>{
 const f=await fixture(t);await f.start();const run=f.state.executionRuns[0];run.status='failed';run.error='Error: 后台产物不在本任务工作目录内'
 let closed=0,offset
 const originalGet=f.service.ctx.get
 f.service.ctx.get=name=>name==='sessionPersistence'?{open:async()=>({header:{parentSession:'parent'},inheritedEventCount:500,read:async n=>{offset=n;return {events:savedOutput()}},close:async()=>{closed++}})}:originalGet(name)
 await f.service.recoverDeliveries();await f.service.recoverDeliveries()
 assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);assert.equal(offset,500);assert.equal(closed,1);assert.equal(run.status,'completed');assert.equal(run.error,undefined)
})


test('cancel preserves a resumable task; explicit resume keeps ids, cwd, result contract and foreground delivery',async t=>{
 const f=await fixture(t),accepted=await f.start(),id=accepted.taskId
 f.setEvents([f.event('update')]);const canceled=await f.tool.execute({action:'cancel',taskId:id},f.exec)
 assert.equal(canceled.canResume,true);assert.equal(f.state.executionRuns[0].status,'canceled')
 const resumed=await f.tool.execute({action:'resume',taskId:id,input:'继续尚未完成的配图'},f.exec)
 assert.equal(resumed.resumed,true);assert.equal(resumed.childSessionId,accepted.childSessionId);assert.equal(f.calls.length,1);assert.equal(f.resumes.length,1)
 assert.equal(f.resumes[0].cwd,f.calls[0].cwd);assert.deepEqual(f.resumes[0].outputSchema,f.calls[0].outputSchema);assert.equal(f.resumes[0].delivery,'caller')
 assert.match(f.resumes[0].prompt[0].text,/不重复执行/)
 assert.equal((await f.tool.execute({action:'resume',taskId:id},f.exec)).alreadyAccepted,true);assert.equal(f.resumes.length,1)
 // The first activation can settle late: it must neither deliver nor release the new guard.
 f.result.resolve({stopReason:'completed',structured:{text:'过期结果',files:[]}});await new Promise(r=>setTimeout(r,15));assert.equal(f.sent.length,0)
 assert.match(f.guards[0]({agent:{session:{id:accepted.childSessionId}},name:'partner_chat_reply',arguments:{}}),/不直接聊天/)
 f.resumeResult.resolve({stopReason:'completed',structured:{text:'续做完成',files:[]}})
 await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].reply.text,'续做完成');assert.equal(f.state.executionRuns[0].status,'completed')
})
test('canceled work can cold-resume after adapter restart without a new child',async t=>{
 const f=await fixture(t),a=await f.start();await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec);await f.service.close()
 const service=new NativeBackgroundTasks(f.ctx,f.store,f.deliver);t.after(()=>service.close());f.setEvents([f.event('update')])
 const result=await service.tool('c').execute({action:'resume',taskId:a.taskId},f.exec)
 assert.equal(result.childSessionId,a.childSessionId);assert.equal(f.resumes.length,1);assert.equal(f.calls.length,1)
 f.resumeResult.resolve({stopReason:'completed',structured:{text:'重启后继续完成',files:[]}});await waitFor(()=>f.state.executionRuns[0].background.deliveredAt)
 assert.equal(f.sent.length,1)
})

test('the generic startup recovery leaves interrupted native background tasks for their own recovery',async t=>{
 const f=await fixture(t)
 const accepted=await f.start();await f.service.close()
 const {EphemeralExecutionService}=await import('../lib/execution/service.js')
 const execution=new EphemeralExecutionService({},f.store,f.parent.session.header.cwd)
 assert.equal(await execution.reconcileInterruptedRuns(),0)
 assert.equal(f.state.executionRuns[0].status,'running')
 const service=new NativeBackgroundTasks(f.ctx,f.store,f.deliver);t.after(()=>service.close())
 await service.recoverDeliveries()
 const run=f.state.executionRuns[0]
 assert.equal(run.sessionId,accepted.childSessionId)
 assert.equal(run.status,'canceled');assert.match(run.error,/重启/)
 assert.ok(run.background.review);assert.ok(run.background.interruptedAt)
 run.background.review.doneAt=Date.now()
 const {cleanupWorkSession}=await import('../lib/execution/session-cleanup.js')
 const previous=f.ctx.get
 f.ctx.get=name=>name==='sessionPersistence'?{stat:()=>assert.fail('interrupted work stays recoverable'),open:async()=>{}}:previous(name)
 assert.equal(await cleanupWorkSession(f.ctx,f.store,run),false)
})

const savedOutput=(confirmed=true)=>[
 {type:'turn/start',data:{turn:1}},
 {type:'tool/call',data:{name:'structured_output',callId:'output',arguments:{text:'已保存成果',files:[]}}},
 ...(confirmed?[{type:'tool/result',data:{message:{toolCallId:'output',isError:false,content:[]}}}]:[]),
 {type:'turn/end',data:{reason:{kind:'completed'}}},
]

test('restart delivers a committed result once and leaves an unconfirmed result for the original foreground',async t=>{
 for(const confirmed of [true,false]){
  const f=await fixture(t),accepted=await f.start()
  await f.service.close()
  childLog(f,savedOutput(confirmed))
  const service=new NativeBackgroundTasks(f.ctx,f.store,f.deliver);t.after(()=>service.close())
  await service.recoverDeliveries();await service.recoverDeliveries()
  const run=f.state.executionRuns[0]
  assert.equal(run.sessionId,accepted.childSessionId)
  assert.equal(f.calls.length,1);assert.equal(f.resumes.length,0)
  assert.equal(run.status,confirmed?'completed':'canceled')
  assert.equal(f.sent.length,confirmed?1:0)
 }
})

test('pause and stop distinguish a resumable child from work the user has closed',async t=>{
 const f=await fixture(t),accepted=await f.start(),taskId=accepted.taskId,run=f.state.executionRuns[0]
 const paused=await f.tool.execute({action:'pause',taskId},f.exec)
 assert.equal(paused.canResume,true);assert.equal(run.background.stoppedAt,undefined)
 const {cleanupWorkSession}=await import('../lib/execution/session-cleanup.js')
 const previous=f.ctx.get
 f.ctx.get=name=>name==='sessionPersistence'?{stat:async()=>undefined,open:async()=>{}}:previous(name)
 assert.equal(await cleanupWorkSession(f.ctx,f.store,run),false)
 const stopped=await f.tool.execute({action:'stop',taskId},f.exec)
 assert.equal(stopped.stopped,true);assert.equal(stopped.canResume,false)
 f.setEvents([f.event('update')]);await assert.rejects(f.tool.execute({action:'resume',taskId},f.exec),/已回收/)
 assert.equal(await cleanupWorkSession(f.ctx,f.store,run),true)
 assert.ok(run.sessionCleanup.deletedAt)
})
test('resume rejects removed logs, foreign sources and revoked permissions; explicit discard is final',async t=>{
 const f=await fixture(t),a=await f.start();await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec);f.setEvents([f.event('update')])
 f.state.executionRuns[0].sessionCleanup={deletedAt:1}
 await assert.rejects(f.tool.execute({action:'resume',taskId:a.taskId},f.exec),/已回收/);delete f.state.executionRuns[0].sessionCleanup
 f.state.channels[0].enabled=false;await assert.rejects(f.tool.execute({action:'resume',taskId:a.taskId},f.exec),/授权/);f.state.channels[0].enabled=true
 await f.tool.execute({action:'discard',taskId:a.taskId},f.exec);assert.ok(f.state.executionRuns[0].background.discardedAt)
 await assert.rejects(f.tool.execute({action:'resume',taskId:a.taskId},f.exec),/已回收/);assert.equal(f.resumes.length,0)
})
test('failed resume remains canceled with its progress preserved; restart never automatically executes unfinished work',async t=>{
 const f=await fixture(t),a=await f.start();await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec);f.setEvents([f.event('update')])
 f.native.resumeActivation=async()=>{throw Error('capacity unavailable')}
 await assert.rejects(f.tool.execute({action:'resume',taskId:a.taskId},f.exec),/capacity unavailable/);assert.equal(f.state.executionRuns[0].status,'canceled')
 await f.service.close();f.state.executionRuns[0].status='running'
 const service=new NativeBackgroundTasks(f.ctx,f.store,f.deliver);t.after(()=>service.close());await service.recoverDeliveries()
 assert.equal(f.state.executionRuns[0].status,'canceled');assert.match(f.state.executionRuns[0].error,/重启/);assert.equal(f.calls.length,1);assert.equal(f.resumes.length,0)
})


test('ordinary companions can execute multiple foreground tools even with saved disabled role options',async t=>{
 const f=await fixture(t),c=f.state.companions[0]
 c.characterCard={enabled:false,length:'short',segmentedReplies:true};c.relationshipText='旧关系';c.sleepPolicy={enabled:true,dreamsEnabled:true}
 const guard=f.guards[0]
 for(const name of ['generate_image','bash','write','partner_browser','web_search'])assert.equal(guard({...f.exec,name,arguments:{action:'open'}}),undefined,name)
 f.setEvents([f.event('input'),...['one','two','three'].map(callId=>({type:'tool/call',data:{name:'web_search',arguments:{},callId}}))])
 assert.equal(guard({...f.exec,name:'web_fetch',arguments:{}}),undefined)
 c.characterCard.enabled=true
 assert.match(guard({...f.exec,name:'generate_image',arguments:{}}),/必须先/)
 c.characterCard.enabled=false
 assert.equal(guard({...f.exec,name:'generate_image',arguments:{}}),undefined,'revoking the role bundle removes its execution constraint immediately')
})


test('background receives bounded scoped preference data only when role chat and memory are enabled',async t=>{
 let calls=0
 const f=await fixture(t,async run=>{calls++;assert.equal(run.background.routeId,'route');return 'REFERENCE PREFERENCE'})
 f.state.companions[0].automation={memory:{enabled:true}}
 await f.start();assert.equal(calls,1);assert.equal(f.calls[0].prompt.length,2)
 assert.equal(f.calls[0].prompt[1].text,'REFERENCE PREFERENCE')
 const plain=await fixture(t,async()=>{throw Error('must not read preferences')})
 plain.state.companions[0].characterCard.enabled=false;plain.state.companions[0].automation={memory:{enabled:true}}
 await plain.start();assert.equal(plain.calls[0].prompt.length,1)
 const disabled=await fixture(t,async()=>{throw Error('memory disabled')})
 await disabled.start();assert.equal(disabled.calls[0].prompt.length,1)
})

test('child receives source and task directories without parent history and describes approved references without asking the child to copy images',async t=>{
 const f=await fixture(t),accepted=await f.start(),sections=[]
 f.parent.ctx={tools:{definitions:()=>[]}}
 const agent={session:{id:accepted.childSessionId},ctx:{systemPrompt:{section:s=>{sections.push(s);return()=>{}}},tools:{presentAs:()=>()=>{}}}}
 await f.handlers.get('agent/created')({agent})
 const text=sections[0].text
 assert.ok(text.includes(JSON.stringify(f.parent.session.header.cwd)))
 assert.ok(text.includes(JSON.stringify(f.calls[0].cwd)))
 assert.match(text,/前台随任务交接参考图/)
 assert.match(text,/由平台直接带入/)
 assert.equal(f.calls[0].prompt.length,1)
 assert.equal(f.calls[0].prompt[0].text,'目标：整理 /tmp/reference.md 并生成配图')
})

test('native background passes the reference selection from the foreground and preserves it on a plain resume',async t=>{
 const first='IMG-11111111111111111111',second='IMG-22222222222222222222'
 const f=await fixture(t,undefined,{plan:(_agent,_route,inputId,{references})=>references?{
  inputId,selected:references.map(id=>({id})),requested:true,handedOff:true,
 }:{inputId,selected:[],available:[{id:first}]}})
 const accepted=await f.tool.execute({action:'start',label:'配图',input:'生成配图',referenceImages:[first,second]},f.exec)
 const references=()=>f.state.executionRuns[0].background.imageReferences.selected.map(image=>image.id)
 assert.deepEqual(references(),[first,second])
 assert.match(f.calls[0].prompt[1].text,/前台已随任务传入参考图/)
 f.setEvents([f.event('update')]);f.native.sendMessage=async()=>{throw Error('投递失败')}
 await assert.rejects(()=>f.tool.execute({action:'update',taskId:accepted.taskId,input:'只用第二张',referenceImages:[second]},f.exec),/投递失败/)
 assert.deepEqual(references(),[first,second])
 f.native.sendMessage=async(...args)=>{f.updates.push(args)}
 await f.tool.execute({action:'update',taskId:accepted.taskId,input:'只用第二张',referenceImages:[second]},f.exec)
 assert.deepEqual(references(),[second])
 await f.tool.execute({action:'cancel',taskId:accepted.taskId},f.exec)
 await f.tool.execute({action:'resume',taskId:accepted.taskId,input:'继续'},f.exec)
 assert.deepEqual(references(),[second])
 assert.match(f.resumes[0].prompt[1].text,new RegExp(second))
})

test('ordinary QQ member hands off an image, keeps original tools and receives the result on the same route',async t=>{
 const f=await fixture(t);f.state.channels[0].qq.identityBinding.enabled=false
 f.exec.toolSet={view:scope=>{assert.equal(scope,f.parent);return new Map(['generate_image','partner_skill','partner_browser','partner_bilibili'].map(n=>[n,{}]))}}
 const accepted=await f.start(),run=f.state.executionRuns[0],guard=f.guards[0],agent={session:{id:accepted.childSessionId}}
 assert.equal(run.background.audience,'member')
 assert.match(guard({...f.exec,name:'generate_image',arguments:{}}),/后台/)
 assert.equal(guard({agent,name:'generate_image',arguments:{}}),undefined)
 assert.equal(guard({agent,name:'structured_output',arguments:{text:'done',files:[]}}),undefined)
 assert.match(guard({agent,name:'partner_skill',arguments:{}}),/范围/)
 assert.match(guard({agent,name:'hidden_host_tool',arguments:{}}),/范围/)
 await writeFile(join(run.background.cwd,'pic.png'),'picture')
 f.result.resolve({stopReason:'completed',structured:{text:'好了',files:[{path:'pic.png',name:'pic.png',mediaType:'image/png'}]}})
 await waitFor(()=>run.background.deliveredAt)
 assert.equal(f.sent[0].run.background.userId,f.route.userId)
})

test('trusted activity routes its own long work, independent of previous user and later speakers',async t=>{
 const f=await fixture(t)
 f.state.channels[0].qq.identityBinding.enabled=false
 f.state.companions[0].idleContact={enabled:true,routeId:f.route.id}
 f.route.idleContactState={kind:'autonomous',messageId:'wake'}
 const wake={type:'user/message',data:{id:'wake',source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'},content:[]}}
 f.setEvents([wake])
 f.exec.toolSet={view:()=>new Map([['generate_image',{}]])}
 assert.match(f.guards[0]({...f.exec,name:'generate_image',arguments:{}}),/后台/)
 const a=await f.start(),run=f.state.executionRuns[0]
 assert.equal(run.background.inputId,'wake');assert.equal(run.background.audience,'activity')
 assert.equal((await f.start()).taskId,a.taskId)
 f.setEvents([f.event('input')])
 assert.deepEqual((await f.tool.execute({action:'list'},f.exec)).tasks,[])
 f.result.resolve({stopReason:'completed',structured:{text:'完成',files:[]}})
 await waitFor(()=>run.background.deliveredAt)
 f.setEvents([{...wake,data:{...wake.data,id:'unclaimed'}}]);await assert.rejects(f.start(),/来源/)
})

function childLog(f,events){
 f.ctx.get=name=>name==='agents'?{get:id=>id==='parent'?f.parent:undefined}:name==='sessionPersistence'?{
  open:async()=>({header:{parentSession:'parent'},inheritedEventCount:0,read:async()=>({events}),close:async()=>{}}),
 }:f.native
}
const loggedImage=(output,reference)=>[
 {type:'tool/call',data:{name:'generate_image',callId:'image',arguments:{reference}}},
 {type:'tool/result',data:{message:{toolCallId:'image',content:[{type:'text',text:JSON.stringify({files:[{path:output}],reference})}]}}},
 {type:'turn/end',data:{reason:{kind:'completed'}}},
]
test('missing manifest gives child one receipt-only step and never repeats image work',async t=>{
 const f=await fixture(t),accepted=await f.start(),steered=[]
 f.parent.ctx={tools:{definitions:()=>[]}}
 const agent={session:{id:accepted.childSessionId},ctx:{systemPrompt:{section:()=>()=>{}},tools:{presentAs:()=>()=>{}}},steer:m=>steered.push(m)}
 await f.handlers.get('agent/created')({agent})
 const stop=()=>f.handlers.get('agent/turn-stopping')({agent,signal:f.exec.signal})
 stop();stop();assert.equal(steered.length,1);assert.match(steered[0].content[0].text,/structured_output/)
 assert.match(f.guards[0]({agent,name:'generate_image',arguments:{}}),/只补交/)
 assert.match(f.guards[0]({agent,name:'structured_output',arguments:{text:'done',files:Array(10).fill({})}}),/最多八个/)
 assert.equal(f.guards[0]({agent,name:'structured_output',arguments:{text:'done',files:[]}}),undefined)
 f.result.resolve({stopReason:'completed',structured:{text:'已交清单',files:[]}})
 await waitFor(()=>f.sent.length===1);assert.equal(f.resumes.length,0)
})
test('error with successful image hands verified file to foreground before cleanup and delivers once',async t=>{
 const f=await fixture(t),{mkdir,readFile}=await import('node:fs/promises')
 f.native.resumeActivation=undefined
 const dir=join(f.parent.session.header.cwd,'generated'),output=join(dir,'original.png'),reference=join(dir,'reference.png')
 await mkdir(dir);await writeFile(output,'image-data');await writeFile(reference,'ref')
 childLog(f,loggedImage(output,reference))
 const gate=deferred();let reviews=0
 f.service.review=async run=>{
  reviews++;assert.match(run.background.review.reason,/没有返回已确认/)
  assert.deepEqual(run.background.review.files.map(x=>x.name),['original.png'])
  await gate.promise
  await f.store.update(s=>{s.executionRuns[0].background.review.decision={action:'deliver',text:'这张先给你',files:[0]}})
 }
 await f.start();f.result.resolve({stopReason:'error'})
 await waitFor(()=>reviews===1)
 const run=f.state.executionRuns[0]
 const {cleanupWorkSession}=await import('../lib/execution/session-cleanup.js')
 assert.equal(await cleanupWorkSession(f.ctx,f.store,run),false)
 await f.service.recoverDeliveries();assert.equal(reviews,1)
 gate.resolve();await waitFor(()=>run.background.review.doneAt)
 assert.equal(run.status,'failed');assert.ok(run.background.deliveredAt);assert.equal(f.sent.length,1)
 assert.equal(await readFile(f.sent[0].reply.attachments[0].path,'utf8'),'image-data')
 assert.equal(f.sent[0].reply.text,'这张先给你');assert.equal(f.calls.length,1)
 await f.service.recoverDeliveries();assert.equal(f.sent.length,1)
})
test('foreground can continue a non-retryable interrupted child once; second failure is held off group',async t=>{
 const f=await fixture(t);childLog(f,[{type:'turn/end',data:{reason:{kind:'error',error:{code:'interrupted',message:'run interrupted'}}}}])
 const decisions=[]
 f.service.review=async run=>{
  const r=run.background.review
  assert.match(r.reason,/interrupted run interrupted/);decisions.push(r.canResume)
  await f.store.update(s=>{s.executionRuns[0].background.review.decision={action:r.canResume?'continue':'hold',text:r.canResume?'只核实缺失文件':'保留进度',files:[]}})
 }
 const a=await f.start();f.result.resolve({stopReason:'interrupted'});await waitFor(()=>f.resumes.length===1)
 assert.equal(f.resumes[0].childId,a.childSessionId);assert.equal(f.resumes[0].cwd,f.calls[0].cwd)
 await waitFor(()=>f.state.executionRuns[0].status==='running'&&!f.service.reviews.size)
 f.resumeResult.resolve({stopReason:'interrupted'})
 await waitFor(()=>f.state.executionRuns[0].background.review?.doneAt)
 assert.deepEqual(decisions,[true,false]);assert.equal(f.calls.length,1);assert.equal(f.sent.length,0)
 assert.equal(f.state.executionRuns[0].outputSummary,'保留进度')
})
test('member manifest outside task workspace requires the exact successful image receipt',async t=>{
 for(const include of [true,false]){
  const f=await fixture(t);f.state.channels[0].qq.identityBinding.enabled=false;f.exec.toolSet={view:()=>new Map([['generate_image',{}]])}
  const {mkdir}=await import('node:fs/promises'),dir=join(f.parent.session.header.cwd,'generated')
  const out=join(dir,'mine.png'),ref=join(dir,'private.png')
  await mkdir(dir);await writeFile(out,'mine');await writeFile(ref,'private')
  childLog(f,loggedImage(out,ref));await f.start()
  f.result.resolve({stopReason:'completed',structured:{text:'完成',files:[{name:'mine.png',path:include?out:ref,mediaType:'image/png'}]}})
  const run=f.state.executionRuns[0]
  await waitFor(()=>include?run.background.deliveredAt:run.background.review)
  assert.equal(f.sent.length,include?1:0)
  if(include)assert.ok(f.sent[0].reply.attachments[0].path.startsWith(run.background.cwd+'/'))
 }
})

test('error with a committed non-image result preserves its report and foreground decision',async t=>{
 const f=await fixture(t);childLog(f,[])
 f.service.review=async run=>{
  const review=run.background.review
  assert.equal(review.lastStatement,'只完成第一章');assert.deepEqual(review.files.map(x=>x.name),['部分报告.md'])
  await f.store.update(s=>{s.executionRuns[0].background.review.decision={action:'deliver',text:'第一章整理好了',files:[0]}})
 }
 await f.start();const run=f.state.executionRuns[0]
 await writeFile(join(run.background.cwd,'partial.md'),'chapter one')
 f.result.resolve({stopReason:'error',structured:{text:'只完成第一章',files:[{path:'partial.md',name:'部分报告.md',mediaType:'text/markdown'}]}})
 await waitFor(()=>run.background.review?.doneAt)
 assert.ok(run.background.deliveredAt);assert.equal(f.sent[0].reply.attachments[0].name,'部分报告.md')
})
test('explicit cancellation during pending review keeps child resumable and never delivers stale decision',async t=>{
 const f=await fixture(t),gate=deferred();childLog(f,[])
 f.service.review=async()=>{await gate.promise}
 const a=await f.start();f.result.resolve({stopReason:'error'})
 await waitFor(()=>f.state.executionRuns[0].background.review)
 f.setEvents([f.event('update')])
 const receipt=await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec)
 assert.equal(receipt.canResume,true);gate.resolve()
 await waitFor(()=>!f.service.reviews.size)
 await f.service.recoverDeliveries()
 assert.equal(f.state.executionRuns[0].status,'canceled');assert.equal(f.sent.length,0)
})

test('web input in a QQ-bound thread uses the same native background tool and returns to that web session',async t=>{
 const f=await fixture(t),{Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm')
 const {recordLocalInputOrigins}=await import('../lib/conversation-history-recall.js')
 const {resolveToolAccess}=await import('../lib/execution/tool-access-adapter.js')
 const initial=Session.create('parent'),session=Session.create('parent',[],{...initial.header,cwd:f.parent.session.header.cwd})
 f.parent.session=session
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请后台执行网页里的工作'}]})
 recordLocalInputOrigins(session,[message],f.state.sessions)
 session.append('user/message',message,{surfaceOp:'append'})
 assert.deepEqual(resolveToolAccess({agent:f.parent,state:f.state}),{sendTools:true})
 assert.match(f.guards[0]({...f.exec,name:'generate_image',arguments:{}}),/必须先/)
 const accepted=await f.start()
 const run=f.state.executionRuns[0]
 assert.equal(accepted.independent,true);assert.equal(f.calls[0].parent,f.parent)
 assert.equal(run.background.sourceKind,'local');assert.equal(run.background.sourceSessionId,'parent')
 assert.notEqual(run.background.routeId,f.route.id)
 const running=await f.tool.execute({action:'status',taskId:accepted.taskId},f.exec)
 assert.deepEqual(running,JSON.parse(JSON.stringify(running)))
 const group=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'我是群里的另一条消息'}]})
 f.route.inboundMessageIds.push(group.id)
 session.append('user/message',group,{surfaceOp:'append'})
 await assert.rejects(f.tool.execute({action:'status',taskId:accepted.taskId},f.exec),/没有这项/)
 f.result.resolve({stopReason:'completed',structured:{text:'网页结果',files:[]}})
 await waitFor(()=>run.background.deliveredAt)
 assert.equal(f.sent[0].run.background.sourceKind,'local')
 assert.equal(f.sent[0].run.background.sourceSessionId,'parent')
 assert.equal(f.sent[0].run.background.targetId,'')
})

test('a linked thread with no admitted browser origin cannot be elevated by an unknown input',async t=>{
 const f=await fixture(t);f.setEvents([f.event('unknown')])
 await assert.rejects(f.start(),/来源明确/);assert.equal(f.calls.length,0)
})

test('recoverable background failures retry twice on the same native child before foreground handling',async t=>{
 const f=await fixture(t)
 childLog(f,[{type:'turn/end',data:{reason:{kind:'error',error:{code:'NETWORK_ERROR',message:'connection closed'}}}}])
 let reviews=0
 f.service.review=async run=>{
   reviews++
   assert.equal(run.background.retries,2)
   assert.equal(run.background.review.canResume,false)
   await f.store.update(s=>{s.executionRuns[0].background.review.decision={action:'hold',text:'保留剩余进度',files:[]}})
 }
 const attempts=[deferred(),deferred()]
 f.native.resumeActivation=async spec=>{
   const result=attempts[f.resumes.length]
   assert.ok(result,'third retry must never start')
   f.resumes.push(spec)
   return {childId:spec.childId,name:'agent-1',result:result.promise,dispose:async()=>{}}
 }
 const first=await f.start()
 f.result.resolve({stopReason:'error'})
 await waitFor(()=>f.resumes.length===1)
 assert.equal(reviews,0);assert.equal(f.resumes[0].childId,first.childSessionId)
 assert.equal(f.resumes[0].agentOptions,undefined)
 attempts[0].resolve({stopReason:'error'})
 await waitFor(()=>f.resumes.length===2)
 assert.equal(reviews,0);assert.equal(f.resumes[1].childId,first.childSessionId)
 attempts[1].resolve({stopReason:'error'})
 await waitFor(()=>f.state.executionRuns[0].background.review?.doneAt)
 assert.equal(reviews,1);assert.equal(f.calls.length,1);assert.equal(f.sent.length,0)
})
test('a same-origin correction updates the running task once and a separate request may start another',async t=>{
 const f=await fixture(t)
 const start=()=>f.tool.execute({action:'start',label:'重做双人婚纱照',input:'任务：重做双人婚纱照。\n\n两个人都笑。'},f.exec)
 const first=await start()
 const correction=f.event('update')
 correction.data.content=[{type:'text',text:'我觉得背景都有点假，没笑，动作也有点僵，你自己再琢磨'}]
 f.setEvents([correction])
 const add=()=>f.tool.execute({action:'start',label:'婚纱照真实感重做',input:'任务：重做一版双人婚纱照。\n\n背景用实景。'},f.exec)
 const second=await add()
 assert.equal(second.updated,true);assert.equal(second.taskId,first.taskId);assert.equal(f.updates.length,1)
 assert.equal((await add()).alreadyAccepted,true);assert.equal(f.updates.length,1);assert.equal(f.calls.length,1)
 const other=f.event('separate');other.data.content=[{type:'text',text:'另外开独立任务拍一张小猫'}];f.route.inboundMessageIds.push('separate');f.setEvents([other])
 await f.tool.execute({action:'start',label:'小猫照片',input:'做一张小猫照片'},f.exec)
 assert.equal(f.calls.length,2)
})
test('manual native stop retires the child log without triggering any retry or group text',async t=>{
 const f=await fixture(t);childLog(f,[])
 f.service.review=async()=>assert.fail('explicit stop needs no automatic review')
 await f.start()
 f.result.resolve({stopReason:'aborted'})
 const run=f.state.executionRuns[0]
 await waitFor(()=>run.background.stoppedAt)
 assert.equal(run.status,'canceled');assert.equal(f.resumes.length,0);assert.equal(f.sent.length,0)
 run.background.imageReferences={selected:[],requested:true}
 const {cleanupWorkSession}=await import('../lib/execution/session-cleanup.js')
 const previous=f.ctx.get
 f.ctx.get=name=>name==='sessionPersistence'?{stat:async()=>undefined,open:async()=>{}}:previous(name)
 assert.equal(await cleanupWorkSession(f.ctx,f.store,run),true)
 assert.ok(run.sessionCleanup.deletedAt)
 assert.equal(run.background.imageReferences,undefined)
})

test('oversized body recovery selects native offload occurrences only from the failed child history',async()=>{
 const {retryMode,offloadBackgroundImages}=await import('../lib/execution/background-retry.js')
 assert.equal(retryMode('INVALID_REQUEST 400: maximum 8 MiB'),'images')
 assert.equal(retryMode('INVALID_REQUEST 400: wrong field'),undefined)
 const operations=[],events=new Map([
  [1,{type:'user/message',blocks:[{type:'image',offloaded:true},{type:'image'},{type:'text'}]}],
  [2,{type:'assistant/message',blocks:[{type:'image'}]}],
  [3,{type:'tool/result',blocks:[{type:'text'},{type:'image'}]}],
 ])
 const session={surface:{nodes:[1,2,3]},eventAt:seq=>events.get(seq),deriveEventMessage:e=>({content:e.blocks}),append:(...args)=>operations.push(args)}
 assert.equal(offloadBackgroundImages(session),true)
 assert.deepEqual(operations,[['image/offload',{targets:[{seq:1,imageIndexes:[1]},{seq:3,imageIndexes:[0]}]}]])
})
