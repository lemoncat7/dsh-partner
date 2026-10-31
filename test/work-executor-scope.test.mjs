import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {Session} from '@deepseek-ai/dsh-session'
import {PartnerStore} from '../lib/store.js'
import {EphemeralExecutionService} from '../lib/execution/service.js'

const definition=(name,execute)=>({name,description:name,parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute})

test('real ephemeral service restricts native preset and MCP tools to bridge, records same owner, disposes scope',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'partner-work-scope-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(dir,'state.json')),companion=store.snapshot().companions[0]
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{}});new ToolRuntime(root)
 let danger=0,bridge=0,disposed=0,captured,scope
 root.provide('agentPresets',{mount:async ctx=>{ctx.tools.register(definition('native_danger',async()=>{danger++;return {ok:true}}))}})
 const ctx={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'fake'})},workspaceRegistry:{create:async()=>{throw Error('must not attach transient work to main history')}},agents:{async create(options){
  captured=options
  const agent={session:Session.create(options.sessionId),options:{},cancel(){},followup(message){this.session.append('user/message',message,{surfaceOp:'append'})},async whenIdle(){
   const run=name=>root.tools.execute({name,arguments:{},agent:this,signal:new AbortController().signal,callId:name})
   assert.equal((await run('native_danger')).isError,true)
   assert.equal((await run('bridge_operation')).isError,false)
   assert.equal(root.tools.get('unrelated_mcp',this),undefined)
  }}
  scope=createScope(root,agent);agent.ctx=scope.ctx
  await options.setup(scope.ctx,agent)
  return {agent,async dispose(){disposed++;scope.dispose()}}
 }}}
 const executor=new EphemeralExecutionService(ctx,store,dir);t.after(()=>executor.close())
 executor.setMcpTools(()=>[definition('unrelated_mcp',async()=>({ok:true}))])
 const result=await executor.execute({kind:'work',sourceId:'work-test',companion,parentSessionId:'original',prompt:'只检查指定资料',bridgeTools:[definition('bridge_operation',async()=>{bridge++;return {ok:true}})],collectOutput:()=>JSON.stringify({facts:['verified']}),destroyAfterRun:true})
 assert.equal(result.run.ownerCompanionId,companion.id);assert.equal(result.run.kind,'work');assert.equal(result.run.status,'completed')
 assert.equal(captured.meta.parentSession,'original');assert.equal(danger,0);assert.equal(bridge,1);assert.equal(disposed,1)
 assert.equal(store.snapshot().sessions.length,0)
 assert.equal(store.snapshot().executionRuns[0].status,'completed')
 assert.equal(store.snapshot().companions.length,1)
})
