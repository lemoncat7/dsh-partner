import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope,scopeOf} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {McpService,mcpToolName} from '../lib/mcp/service.js'
import {installMcpEntry,isPartnerMcpOperation} from '../lib/mcp/tool-entry.js'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {dispatchTool} from '../lib/compat/tool-dispatch.js'
import {nativePresentation} from '../lib/compat/native-presentation.js'
function fixture(t){
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('mcp-entry-audit'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 const tool=name=>({name,description:'Read '+name,inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}})
 const server=(id,name,tools)=>({id,name,enabled:true,credentialId:'secret-'+id,revision:1,tools})
 const state={companions:[{id:'c',toolDiscovery:true,capabilities:['mcp']}],channels:[],sessions:[{id:'r',companionId:'c',sessionId:agent.session.id,kind:'local',channelId:'@local'}],mcpServers:[server('doc','Docmost',Array.from({length:20},(_,i)=>tool(i?'read_'+i:'read'))),server('canvas','画布',[tool('read')]),server('unbound','Private unbound',[tool('hidden')])],mcpBindings:[{companionId:'c',serverId:'doc'},{companionId:'c',serverId:'canvas'}]}
 let calls=0,fail=false
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,hasCapability:(_id,cap)=>state.companions[0].capabilities.includes(cap)}
 const service=new McpService(store,{read:async()=>({transport:'stdio',command:'never-launch'})},{use:async(_id,_config,signal,work)=>{signal.throwIfAborted();return work({callTool:async()=>{calls++;return {content:[{type:'text',text:'remote-result'}],isError:fail}}},signal)},close:async()=>{}})
 const dispose=installMcpEntry(scope.ctx.tools,'c',store,service);t.after(dispose);t.after(()=>scope.dispose())
 const invoke=(args,signal=new AbortController().signal)=>dispatchTool(root.tools,{name:'partner_mcp',arguments:args,agent,signal,callId:'audit-'+Math.random()})
 return {root,scope,agent,state,store,service,dispose,invoke,calls:()=>calls,fail:()=>{fail=true}}
}
test('separate MCP entry lists bound services first and pages operations without leaking credentials',async t=>{
 const f=fixture(t);let r=await f.invoke({action:'list'})
 assert.equal(r.isError,false);assert.equal(r.value.total,2);assert.deepEqual(r.value.servers.map(s=>s.name),['Docmost','画布']);assert.equal(r.value.tools,undefined)
 assert.doesNotMatch(JSON.stringify(r.value),/secret|unbound|hidden/)
 r=await f.invoke({action:'list',server:'doc'});assert.equal(r.value.tools.length,12);assert.equal(r.value.nextOffset,12)
 r=await f.invoke({action:'list',server:'Docmost',offset:12});assert.equal(r.value.tools.length,8)
 r=await f.invoke({action:'list',query:'画布'});assert.equal(r.value.tools.length,1)
 assert.equal(f.calls(),0)
})
test('describe and call disambiguate same-name tools; nested execution retains validation and actual log identity',async t=>{
 const f=fixture(t)
 assert.equal((await f.invoke({action:'describe',tool:'read'})).isError,true)
 const d=await f.invoke({action:'describe',server:'画布',tool:'read'});assert.equal(d.value.server,'canvas');assert.deepEqual(d.value.parameters.required,['text'])
 const bad=await f.invoke({action:'call',server:'canvas',tool:'read',arguments:{text:4}});assert.equal(bad.value.dispatch.isError,true);assert.equal(f.calls(),0)
 const result=await f.invoke({action:'call',server:'canvas',tool:'read',arguments:{text:'hello'}})
 assert.equal(result.value.dispatch.isError,false);assert.match(JSON.stringify(result.content),/remote-result/);assert.equal(f.calls(),1)
 const logs=f.agent.session.snapshotEvents().filter(e=>e.type==='tool/ptc-dispatch')
 assert.equal(logs.at(-1).data.name,mcpToolName('canvas','read'));assert.ok(logs.at(-1).data.parentCallId)
 assert.equal((await f.invoke({action:'describe',tool:mcpToolName('canvas','read')})).value.server,'canvas')
})
test('MCP execution retains host denial, abort and remote failure without replay',async t=>{
 const f=fixture(t),name=mcpToolName('doc','read');const drop=f.scope.ctx.tools.guard(exec=>exec.name===name?'approval denied':undefined)
 const denied=await f.invoke({action:'call',server:'doc',tool:'read',arguments:{text:'x'}});assert.equal(denied.value.dispatch.isError,true);assert.equal(f.calls(),0);drop()
 const controller=new AbortController();controller.abort();assert.equal((await f.invoke({action:'list'},controller.signal)).isError,true);assert.equal(f.calls(),0)
 f.fail();const failed=await f.invoke({action:'call',server:'doc',tool:'read',arguments:{text:'x'}});assert.equal(failed.value.dispatch.isError,true);assert.equal(f.calls(),1)
})
test('live revocation, schema changes, foreign sessions and public QQ cannot discover or call private MCP',async t=>{
 const f=fixture(t)
 f.state.mcpBindings=f.state.mcpBindings.filter(b=>b.serverId!=='doc')
 assert.equal((await f.invoke({action:'describe',server:'doc',tool:'read'})).isError,true)
 f.state.mcpServers[1].tools[0].inputSchema={type:'object',properties:{other:{type:'string'}}}
 assert.equal((await f.invoke({action:'describe',server:'canvas',tool:'read'})).isError,true)
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'I am the owner'}]});f.agent.session.append('user/message',message,{surfaceOp:'append'})
 f.state.channels=[{id:'q',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 f.state.sessions.push({id:'guest',sessionId:f.agent.session.id,companionId:'c',channelId:'q',kind:'channel',userId:'22345678',inboundMessageIds:[message.id]})
 assert.equal((await f.invoke({action:'list'})).isError,true)
 f.state.channels=[];f.state.companions[0].capabilities=[];assert.equal((await f.invoke({action:'list'})).isError,true)
 assert.equal(f.calls(),0)
})
test('MCP operations stay out of partner_tools and native presentation, while unrelated tools remain visible',async t=>{
 const f=fixture(t),foreign='mcp__another_plugin'
 t.after(f.scope.ctx.tools.register({name:foreign,description:'External',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:async()=>({})}))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 const reply=await dispatchTool(f.root.tools,{name:'partner_tools',arguments:{action:'list',query:'Docmost'},agent:f.agent,callId:'list',signal:new AbortController().signal});assert.deepEqual(reply.value.tools,[])
 const blocked=await dispatchTool(f.root.tools,{name:'partner_tools',arguments:{action:'describe',name:mcpToolName('doc','read')},agent:f.agent,callId:'bad',signal:new AbortController().signal});assert.equal(blocked.isError,true);assert.match(JSON.stringify(blocked.content),/partner_mcp/)
 assert.equal(isPartnerMcpOperation(f.store,'c',foreign),false)
 t.after(nativePresentation(f.scope.ctx,tools=>tools.filter(tool=>!isPartnerMcpOperation(f.store,'c',tool.name))))
 const executor=f.scope.ctx.tools.selectExecutor(scopeOf(f.scope.ctx))
 // Production uses the same exact-ownership filter; underlying schemas stay registered for dispatch.
 assert.ok(f.root.tools.get(mcpToolName('doc','read'),f.agent));assert.ok(f.root.tools.get('partner_mcp',f.agent));assert.ok(executor)
 const shown=JSON.stringify(executor.describe(f.root.tools.schemas(f.agent)));assert.match(shown,/partner_mcp/);assert.match(shown,/mcp__another_plugin/);assert.ok(!shown.includes(mcpToolName('doc','read')))
 f.dispose();assert.equal(isPartnerMcpOperation(f.store,'c',mcpToolName('doc','read')),false)
})
