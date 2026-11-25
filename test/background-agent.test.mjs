import assert from 'node:assert/strict'
import test from 'node:test'
import {Session} from '@deepseek-ai/dsh-session'
import {foldSubagentDescriptor,SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import {Context,Service} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {agentEvents} from '@deepseek-ai/dsh-agent'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import { backgroundResult, PartnerBackgroundAgents } from '../lib/execution/background-agent.js'

const output = { text: '报告已完成', files: [] }
const turnStart = { type: 'turn/start' }
const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
const outputCall = { type: 'tool/call', data: { name: 'structured_output', callId: 'output', arguments: JSON.stringify(output) } }
const outputReceipt = { type: 'tool/result', data: { message: { toolCallId: 'output' } } }

test('background delivery reads a committed structured result from the latest completed turn', () => {
  const completed = [turnStart, outputCall, outputReceipt, turnEnd]
  assert.deepEqual(backgroundResult(completed), { stopReason: 'completed', structured: output })
  assert.deepEqual(backgroundResult([...completed, turnStart, outputCall, turnEnd]), { stopReason: 'completed' })
  assert.deepEqual(backgroundResult([...completed, turnStart, outputCall, outputReceipt]), { stopReason: 'error' })
})


// Real native service, provider, projections and tool pipeline. Only the Agent
// driver/persistence boundary is in-memory; no model or outbound channel runs.
async function nativeFixture(t) {
 const root=new Context(),owner=root.plugin(function nativeBackgroundTest(){})
 const ctx=owner.ctx,live=new Map(),stored=new Map(),scopes=[],projections=new Map(),calls=[],notices=[],edges=[]
 new SystemPrompt(ctx,{});new ToolRuntime(ctx)
 ctx.provide('sessions',{get:()=>undefined,flush:async()=>{}})
 ctx.provide('workingDirectory',{ensure:async()=>'/tmp',set:async()=>{}})
 ctx.provide('sessionProjections',{register:async definition=>{
  projections.set(definition.key,definition)
  return {stateOf(session){let state=definition.init(session.header,session.inheritedEventCount);for(const event of session.snapshotEvents())state=definition.apply(state,event);return state}}
 }})
 const values=session=>Object.fromEntries([...projections].map(([key,def])=>{
  let state=def.init(session.header,session.inheritedEventCount)
  for(const event of session.snapshotEvents())state=def.apply(state,event)
  return [key,def.wire?.view?def.wire.view(state):state]
 }))
 let released=0
 ctx.provide('sessionQuery',{async observeSession(id){
  const session=live.get(id)?.session??stored.get(id)
  if(!session)throw Error('missing session')
  return {header:session.header,events:session.snapshotEvents(),inheritedEventCount:session.inheritedEventCount,projections:{values:values(session)},[Symbol.dispose](){released++}}
 }})
 ctx.provide('sessionPersistence',{stat:async id=>stored.has(id)?{header:stored.get(id).header}:undefined,flush:async()=>{}})
 async function factory(options,resume){
  calls.push({resume,options})
  const id=resume?options.resumeSessionId:options.sessionId
  const session=resume?stored.get(id):Session.create(id,options.seed??[],{type:'session',version:4,id,createdAt:1000,cwd:'/tmp',isSeeded:false,...options.meta},options.inheritedEventCount??0)
  const agent={id,session,options:options.agentOptions??{},inbox:{nextStep:[],nextTurn:[],clear(){this.nextStep=[];this.nextTurn=[]}},status:'idle',turn:0}
  const scope=createScope(ctx,agent,{parent:options.parentAgent});scopes.push(scope);agent.ctx=scope.ctx
  let idle=Promise.withResolvers();idle.resolve()
  const deliver=message=>{
   if(agent.status==='idle'){
    idle=Promise.withResolvers();agent.status='running';agent.turn++
    session.append('turn/start',{turn:agent.turn})
    session.append('step/start',{turn:agent.turn,step:0})
   }
   session.append('user/message',message,{surfaceOp:'append'})
  }
  agent.followup=deliver;agent.steer=deliver;agent.whenIdle=()=>idle.promise
  agent.runMaintenance=fn=>fn(new AbortController().signal)
  agent.complete=reason=>{
   if(agent.status==='idle')return
   session.append('step/end',{turn:agent.turn,step:0})
   session.append('turn/end',{turn:agent.turn,reason:{kind:reason??'completed'}})
   agent.status='idle';idle.resolve()
  }
  agent.cancel=()=>agent.complete('aborted')
  await options.setup?.(agent.ctx,agent)
  live.set(id,agent);stored.set(id,session)
  try{await agentEvents(ctx,agent).serial('agent/created',{source:resume?'resume':'startup'})}
  catch(error){live.delete(id);await scope.dispose();throw error}
  let disposed=false
  return {agent,async dispose(){if(disposed)return;disposed=true;agent.cancel();agentEvents(ctx,agent).emit('agent/disposed',{});live.delete(id);await scope.dispose()}}
 }
 ctx.provide('agents',{get:id=>live.get(id),list:()=>[...live.values()],create:options=>factory(options,false),resume:options=>factory(options,true)})
 const native=new SubagentRuntime(ctx,{maxDepth:{get:()=>1},maxActiveSubagents:{get:()=>8}})
 await native[Service.init]()
 await new Promise(resolve=>setTimeout(resolve,0))
 const parentSession=Session.create('parent')
 const parent={id:'parent',session:parentSession,options:{provider:'test',model:'main'},status:'idle',steer:message=>notices.push(message),followup:message=>notices.push(message)}
 const parentScope=createScope(ctx,parent);scopes.push(parentScope);parent.ctx=parentScope.ctx;live.set(parent.id,parent)
 ctx.on('subagent/start',info=>edges.push({type:'start',...info}));ctx.on('subagent/end',info=>edges.push({type:'end',...info}))
 const adapter=new PartnerBackgroundAgents(ctx)
 t.after(async()=>{await native.drainDescendants([parent]);adapter.close();for(const scope of scopes.reverse())await scope.dispose();await owner.dispose()})
 const spec={parent,childId:'child',cwd:'/tmp',label:'提取B站视频',signal:new AbortController().signal,prompt:[{type:'text',text:'private task prompt'}],outputSchema:{type:'object',properties:{text:{type:'string'},files:{type:'array',items:{type:'object'}}},required:['text','files']},authorize(){}}
 const submit=async(value=output,extra={})=>{
  const agent=live.get(spec.childId)
  const result=await dispatchTool(ctx.tools,{name:'structured_output',arguments:value,agent,signal:new AbortController().signal,...extra})
  return result
 }
 return {ctx,native,adapter,parent,live,stored,calls,notices,edges,spec,submit,values,released:()=>released}
}

test('native runtime creates and catalogs background work, owns disposal and returns structured output to caller', {timeout:5000},async t=>{
 const f=await nativeFixture(t),run=await f.adapter.startActivation(f.spec),child=f.live.get('child')
 const descriptor=foldSubagentDescriptor(child.session.snapshotEvents())
 assert.equal(descriptor.mode,'continuable');assert.equal(descriptor.provider,'partner-background')
 assert.ok((await f.native.listDescendants('parent')).some(row=>row.id==='child'&&row.mode==='continuable'&&row.label===f.spec.label))
 assert.doesNotMatch(JSON.stringify(f.parent.session.snapshotEvents()),/private task prompt/)
 assert.equal(f.calls.length,1);assert.ok(f.calls[0].options.parentAgent===undefined||f.calls[0].options.parentAgent===f.parent)
 const receipt=await f.submit();assert.equal(receipt.isError,false)
 child.complete()
 const result=await run.result
 assert.equal(result.stopReason,'completed');assert.deepEqual(result.structured,output)
 assert.equal(f.live.has('child'),false);assert.equal(f.notices.length,0)
 assert.deepEqual(f.edges.map(e=>e.type),['start','end'])
 await run.dispose()
})

test('native cold resume keeps identity/catalog and returns one committed manifest without a second parent reply', {timeout:5000},async t=>{
 const f=await nativeFixture(t),first=await f.adapter.startActivation(f.spec)
 await first.dispose();await first.result
 assert.equal((await f.adapter.prepareResume('child',f.parent,f.spec.signal)).childId,'child')
 const restored=await f.adapter.resumeActivation({...f.spec,prompt:[{type:'text',text:'继续未完成部分'}]})
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].resume,true)
 assert.ok(f.calls[1].options.parentAgent===undefined||f.calls[1].options.parentAgent===f.parent)
 assert.equal(f.parent.session.snapshotEvents().filter(e=>e.type==='subagent/catalog').length,1)
 assert.equal(foldSubagentDescriptor(f.live.get('child').session.snapshotEvents()).mode,'continuable')
 await f.submit()
 await assert.rejects(f.adapter.sendMessage(f.parent,'child',f.spec.prompt,{signal:f.spec.signal}),/补充未被接收/)
 f.live.get('child').complete()
 assert.deepEqual(await restored.result,{stopReason:'completed',structured:output})
 assert.equal(f.notices.length,1,'native cold continuation emits its normal parent notice')
 const decide=messages=>agentEvents(f.ctx,f.parent).waterfall('agent/pre-step',{messages,turn:1,step:0,signal:f.spec.signal,modelSelection:{}},()=>Promise.resolve({kind:'enter',messages}))
 assert.deepEqual(await decide(f.notices),{kind:'reject'},'Partner already owns this outcome and delivery')
 const user={id:'real',source:{kind:'user'},content:[{type:'text',text:'新问题'}]},other={...f.notices[0],id:'other',source:{...f.notices[0].source,senderSessionId:'someone-else'}}
 const mixed=await decide([f.notices[0],user,other]);assert.deepEqual(mixed.messages,[user,other])
 const again=await f.adapter.resumeActivation(f.spec)
 await restored.dispose();assert.equal(f.live.has('child'),true,'old dispose cannot stop a newer activation')
 await again.dispose();assert.equal((await again.result).stopReason,'aborted')
})

test('native update enforces exact parent and resumed output waits for authoritative outer transport success', {timeout:5000},async t=>{
 const f=await nativeFixture(t),first=await f.adapter.startActivation(f.spec)
 await f.adapter.sendMessage(f.parent,'child',[{type:'text',text:'保留已有产物'}],{signal:f.spec.signal})
 await assert.rejects(f.adapter.sendMessage({...f.parent},'child',[],{signal:f.spec.signal}),/原会话/)
 await first.dispose();await first.result
 const run=await f.adapter.resumeActivation(f.spec),agent=f.live.get('child')
 // Execute the resumed schema through a nested transport, then fail that exact
 // transport's authoritative final receipt. An inner success must not deliver.
 const tool=agent.ctx.tools.get('structured_output',agent)
 const token={},exec={name:'structured_output',parent:token,token:{},concludeTurn(){}}
 await tool.execute(output,exec)
 // Dispatch through the real scoped event bus, as the tool pipeline does.
 const {scopeTarget}=await import('@deepseek-ai/dsh-scope')
 agent.ctx.emit(scopeTarget(agent.ctx.tools,agent),'tools/result',exec,{isError:false})
 agent.ctx.emit(scopeTarget(agent.ctx.tools,agent),'tools/result',{name:'run_code',token},{isError:true})
 agent.complete()
 assert.deepEqual(await run.result,{stopReason:'completed'})
})

test('legacy child history is seeded by native creation without rewriting its identity or re-running its initial input', {timeout:5000},async t=>{
 const f=await nativeFixture(t)
 const old=Session.create('old-child',[],{type:'session',version:4,id:'old-child',createdAt:500,parentSession:'parent',cwd:'/tmp',origin:'subagent',isSeeded:false,delegationDepth:1})
 old.append('turn/start',{turn:1});old.append('step/start',{turn:1,step:0});old.append('step/end',{turn:1,step:0});old.append('turn/end',{turn:1,reason:{kind:'completed'}})
 f.stored.set('old-child',old)
 const before=old.snapshotEvents(),prepared=await f.adapter.prepareResume('old-child',f.parent,f.spec.signal)
 assert.notEqual(prepared.childId,'old-child');assert.deepEqual(prepared.seed,before)
 const run=await f.adapter.startActivation({...f.spec,...prepared,prompt:[{type:'text',text:'只继续未完成部分，核实已有产物'}]})
 assert.deepEqual(old.snapshotEvents(),before)
 assert.deepEqual(f.calls[0].options.seed,before)
 assert.equal(f.live.get(prepared.childId).session.header.parentSession,'parent')
 assert.equal(f.live.get(prepared.childId).session.inheritedEventCount,before.length)
 await run.dispose();await run.result
 assert.equal(f.released(),1)
 await assert.rejects(f.adapter.prepareResume('old-child',{id:'wrong-parent'},f.spec.signal),/原会话不匹配/)
 assert.equal(f.released(),2)
})

test('revocation during native creation releases accepted work; generic UI cannot restore Partner work outside its task authority', {timeout:5000},async t=>{
 const f=await nativeFixture(t),first=await f.adapter.startActivation(f.spec)
 await first.dispose();await first.result
 await assert.rejects(f.native.sendMessage(f.parent,'child',f.spec.prompt,{signal:f.spec.signal}),error=>/伙伴后台任务入口/.test(String(error.cause)))
 assert.equal(f.live.has('child'),false)
 let checks=0
 await assert.rejects(f.adapter.startActivation({...f.spec,childId:'revoked',authorize(){if(++checks>1)throw Error('授权已撤回')}}),/授权已撤回/)
 assert.equal(f.live.has('revoked'),false)
 f.adapter.close()
 assert.equal(f.native.getProvider('partner-background'),undefined)
})
