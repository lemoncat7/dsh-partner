import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertObjectJsonSchema} from '@deepseek-ai/dsh-tools'
import {NativeBackgroundTasks,PARTNER_BACKGROUND_PROVIDER} from '../lib/execution/native-background.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
async function fixture(t){
 const cwd=await mkdtemp(join(tmpdir(),'partner-native-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const channel={id:'q',platform:'qq',accountId:'bot',companionId:'c',enabled:true,direct:{baseUrl:'ws://local',targetId:''},qq:qqSettings({groupReplies:true,groupIds:['12345678'],autonomousGroupIds:['12345678'],identityBinding:{enabled:true,qqIds:['22334455']}})}
 const event=id=>({type:'user/message',data:{id,source:{kind:'user'},content:[{type:'text',text:'整理当前 /tmp/reference.md，生成配图'}]}})
 let events=[event('input')]
 const parent={session:{id:'parent',header:{cwd},snapshotEvents:()=>events}}
 const route={id:'route',kind:'channel',sessionId:'parent',companionId:'c',channelId:'q',userId:'group:12345678:22334455',inboundMessageIds:['input','update']}
 const state={channels:[channel],companions:[{id:'c',capabilities:['work'],characterCard:{enabled:true}}],sessions:[route],pairings:[],executionRuns:[]}
 const subscribers=new Set(),guards=[],calls=[],sent=[],updates=[],resumes=[],resumeResult=deferred(),result=deferred();let disposed=0
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},update:async fn=>{fn(state);for(const listener of subscribers)listener();return structuredClone(state)}}
 const native={getProvider:()=>PARTNER_BACKGROUND_PROVIDER,registerProvider:()=>()=>{},startActivation:async spec=>{calls.push(spec);return {childId:spec.childId,name:'agent-1',result:result.promise,dispose:async()=>{disposed++}}},resumeActivation:async spec=>{resumes.push(spec);return {childId:spec.childId,name:'agent-1',result:resumeResult.promise,dispose:async()=>{disposed++}}},sendMessage:async(...args)=>updates.push(args)}
 const ctx={get:()=>native,tools:{guard:fn=>{guards.push(fn);return()=>guards.splice(guards.indexOf(fn),1)}},logger:{warn(){}}},deliver=async(run,reply)=>sent.push({run:structuredClone(run),reply})
 const service=new NativeBackgroundTasks(ctx,store,deliver)
 t.after(()=>service.close())
 const tool=service.tool('c'),exec={agent:parent,signal:new AbortController().signal}
 const start=()=>tool.execute({action:'start',label:'整理',input:'目标：整理 /tmp/reference.md 并生成配图'},exec)
 return {state,parent,route,store,service,tool,exec,start,calls,sent,updates,result,guards,ctx,deliver,native,resumes,resumeResult,disposed:()=>disposed,setEvents:v=>{events=v},event}
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
 await assert.rejects(f.tool.execute({action:'cancel',taskId:a.taskId},f.exec),/没有这项/)
 f.setEvents([f.event('update')]);await f.tool.execute({action:'cancel',taskId:a.taskId},f.exec);assert.equal(f.state.executionRuns[0].status,'canceled');assert.equal(f.disposed(),1)
 f.result.resolve({stopReason:'completed',structured:{text:'旧结果',files:[]}});await new Promise(r=>setTimeout(r,10));assert.equal(f.sent.length,0)
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
 assert.equal(guard({...f.exec,name:'generate_image',arguments:{}}),undefined)
})
test('unapproved private routes cannot start work',async t=>{
 const f=await fixture(t);f.route.userId='22334455';f.state.channels[0].qq.privateReplies=true
 await assert.rejects(f.start(),/授权/);assert.equal(f.calls.length,0)
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
 f.service.ctx.get=name=>name==='sessionPersistence'?{open:async()=>({header:{parentSession:'parent'},inheritedEventCount:500,read:async n=>{offset=n;return {events:[{type:'tool/call',data:{name:'structured_output',arguments:{text:'已保存成果',files:[]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}]}},close:async()=>{closed++}})}:originalGet(name)
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
