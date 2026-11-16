import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertObjectJsonSchema} from '@deepseek-ai/dsh-tools'
import {NativeBackgroundTasks} from '../lib/execution/native-background.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
async function fixture(t){
 const cwd=await mkdtemp(join(tmpdir(),'partner-native-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const channel={id:'q',platform:'qq',accountId:'bot',companionId:'c',enabled:true,direct:{baseUrl:'ws://local',targetId:''},qq:qqSettings({groupReplies:true,groupIds:['12345678'],autonomousGroupIds:['12345678'],identityBinding:{enabled:true,qqIds:['22334455']}})}
 const event=id=>({type:'user/message',data:{id,source:{kind:'user'},content:[{type:'text',text:'整理当前 /tmp/reference.md，生成配图'}]}})
 let events=[event('input')]
 const parent={session:{id:'parent',header:{cwd},snapshotEvents:()=>events}}
 const route={id:'route',kind:'channel',sessionId:'parent',companionId:'c',channelId:'q',userId:'group:12345678:22334455',inboundMessageIds:['input','update']}
 const state={channels:[channel],companions:[{id:'c',capabilities:['work']}],sessions:[route],pairings:[],executionRuns:[]}
 const subscribers=new Set(),guards=[],calls=[],sent=[],updates=[],result=deferred();let disposed=0
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},update:async fn=>{fn(state);for(const listener of subscribers)listener();return structuredClone(state)}}
 const native={getProvider:()=>({}),startActivation:async spec=>{calls.push(spec);return {childId:spec.childId,name:'agent-1',result:result.promise,dispose:async()=>{disposed++}}},sendMessage:async(...args)=>updates.push(args)}
 const service=new NativeBackgroundTasks({get:()=>native,tools:{guard:fn=>{guards.push(fn);return()=>guards.splice(guards.indexOf(fn),1)}},logger:{warn(){}}},store,async(run,reply)=>sent.push({run:structuredClone(run),reply}))
 t.after(()=>service.close())
 const tool=service.tool('c'),exec={agent:parent,signal:new AbortController().signal}
 const start=()=>tool.execute({action:'start',label:'整理',input:'目标：整理 /tmp/reference.md 并生成配图'},exec)
 return {state,parent,route,store,service,tool,exec,start,calls,sent,updates,result,guards,disposed:()=>disposed,setEvents:v=>{events=v},event}
}
const waitFor=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10))}assert.fail('completion did not settle')}
test('native acceptance returns immediately; ordinary chat does not cancel and result keeps original group',async t=>{
 const f=await fixture(t),accepted=await f.start();assert.equal(accepted.status,'running');assert.equal(f.sent.length,0)
 assertObjectJsonSchema(f.calls[0].outputSchema);assert.equal(f.calls[0].delivery,'caller');assert.equal(f.calls[0].provider,'fork');assert.match(f.calls[0].prompt[0].text,/reference.md/)
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
 assert.equal(f.sent[0].reply.attachments[0].mediaType,'image/png')
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
