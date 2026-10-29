import test from 'node:test'
import assert from 'node:assert/strict'
import {chatTools} from '../lib/chat/tools.js'
import {qqActionTools} from '../lib/channels/qq/actions.js'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {ToolRuntime,renderToolsSdk} from '@deepseek-ai/dsh-tools'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
import {PartnerAgentComposition} from '../lib/collaboration/composition.js'
import {createDefaultCompanion,normalizeCompanionDraft} from '../lib/domain.js'
import {SessionConfigurationIndex} from '../lib/companions/session-configuration.js'

function fixture(t){
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:{id:'s',header:{}},options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 const companion={id:'c',toolDiscovery:true},state={companions:[companion],sessions:[{companionId:'c',sessionId:'s'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 const invoke=(name,args={},signal=new AbortController().signal)=>root.tools.execute({callId:'call-'+name,name,arguments:args,agent,signal})
 t.after(()=>scope.dispose());return {root,agent,scope,store,state,companion,invoke}
}
const definition=(name,execute=async()=>({ok:true}))=>({name,description:'工具说明 '+name,parameters:{type:'object',properties:{text:{type:'string'}}},output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},timeoutMs:5000,execute})

test('discovery loads original tools into the actual scoped runtime without executing; policies still deny',async t=>{
 const f=fixture(t);let calls=0
 const original=definition('partner_identity',async()=>{calls++;return {ok:true}})
 const dispose=installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:original,allowed:()=>true}]);t.after(dispose)
 assert.deepEqual(f.root.tools.schemas(f.agent).map(s=>s.name),['partner_tools'])
 assert.doesNotMatch(renderToolsSdk(f.root.tools.sdkSchemas(f.agent)),/partner_identity/)
 assert.equal((await f.invoke('partner_identity')).isError,true)
 const described=await f.invoke('partner_tools',{action:'describe',name:original.name});assert.equal(described.isError,false);assert.equal(calls,0)
 assert.deepEqual(f.root.tools.schemas(f.agent).map(s=>s.name),['partner_tools'])
 await f.invoke('partner_tools',{action:'load',name:original.name})
 assert.equal(f.root.tools.get(original.name,f.agent),original)
 assert.match(renderToolsSdk(f.root.tools.sdkSchemas(f.agent)),/partner_identity/)
 assert.equal(calls,0);assert.equal((await f.invoke(original.name,{text:'x'})).isError,false);assert.equal(calls,1)
 f.scope.ctx.tools.guard(e=>e.name===original.name?'policy revoked':undefined)
 assert.equal((await f.invoke(original.name)).isError,true);assert.equal(calls,1)
 assert.equal(f.root.tools.schemas().some(s=>s.name===original.name),false,'tools never become global')
 dispose();assert.deepEqual(f.root.tools.schemas(f.agent),[])
})
test('active work tools stay bounded and lookup never executes; scope and capability checks remain',async t=>{
 const f=fixture(t),entries=Array.from({length:8},(_,i)=>({tool:definition('partner_mcp_'+i,()=>{throw Error('must not run')}),allowed:()=>true}))
 const dispose=installToolDiscovery(f.scope.ctx.tools,'c',f.store,entries);t.after(dispose)
 const initial=await f.invoke('partner_tools',{action:'list'});assert.equal(initial.value.categories[0].count,8);assert.equal(initial.value.tools,undefined)
 for(const e of entries)assert.equal((await f.invoke('partner_tools',{action:'load',name:e.tool.name})).isError,false)
 assert.equal(f.root.tools.schemas(f.agent).length,5)
 assert.equal(f.root.tools.get(entries[0].tool.name,f.agent),undefined)
 entries[0].allowed=()=>false;assert.equal((await f.invoke('partner_tools',{action:'load',name:entries[0].tool.name})).isError,true)
 f.state.sessions[0].companionId='other';assert.equal((await f.invoke('partner_tools',{action:'list'})).isError,true)
})
test('loaded definition retains output, presentation and turn conclusion through DSH',async t=>{
 const f=fixture(t),tool=definition('partner_test',async(_args,exec)=>{exec.concludeTurn();return {ok:true}})
 tool.output.presentationMeta=()=>({kind:'original'})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool,allowed:()=>true}]))
 await f.invoke('partner_tools',{action:'load',name:tool.name})
 const result=await f.invoke(tool.name);assert.equal(result.isError,false);assert.equal(result.concludesTurn,true);assert.deepEqual(result.meta,{kind:'original'})
})
test('composition reduces idle schemas while preserving native chat and full work tool loading',async()=>{
 const companion={...createDefaultCompanion(),capabilities:['skills','schedules','companions','access']},state={companions:[companion],sessions:[{sessionId:'s',companionId:companion.id}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,hasCapability:(_id,c)=>companion.capabilities.includes(c)}
 const composition=new PartnerAgentComposition(store,{bindings:()=>[]},{},{directoryFor:()=>[]},{},{},{})
 composition.setChatToolFactory(()=>[...chatTools(companion.id,store,{}, {},{},'/partner-local/v1'),...qqActionTools(companion.id,store,async()=>{})])
 const registered=new Map(),ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name)}},systemPrompt:{section:()=>()=>{}}}
 const legacy=await composition.compose(ctx,companion),full=[...registered.values()].map(({name,description,parameters})=>({name,description,parameters})),before=JSON.stringify(full).length
 legacy();companion.toolDiscovery=true
 const dispose=await composition.compose(ctx,companion)
 assert.deepEqual([...registered.keys()].sort(),['partner_chat_reply','partner_stickers','partner_tools'])
 const after=JSON.stringify([...registered.values()].map(({name,description,parameters})=>({name,description,parameters}))).length
 assert.ok(after<before*0.25,`schema sizes ${before} -> ${after}`)
 const gateway=registered.get('partner_tools'),exec={agent:{session:{id:'s'}},signal:new AbortController().signal}
 await gateway.execute({action:'load',name:'partner_task_board'},exec);assert.ok(registered.has('partner_task_board'))
 const board=registered.get('partner_task_board');assert.deepEqual(board.parameters,full.find(t=>t.name===board.name).parameters)
 dispose();assert.equal(registered.size,0)
 console.log(JSON.stringify({partnerSchemasBefore:full.length,partnerSchemasAfter:3,schemaCharsBefore:before,schemaCharsAfter:after}))
})
test('discovery setting is validated and participates in next-turn composition revision',()=>{
 assert.throws(()=>normalizeCompanionDraft({name:'角色',toolDiscovery:'yes'}))
 const c={...createDefaultCompanion(),toolDiscovery:false},state={companions:[c],sessions:[{sessionId:'s',companionId:c.id}],skillBindings:[],companionAccessGrants:[],skills:[]}
 const index=new SessionConfigurationIndex({snapshot:()=>state,subscribe:()=>()=>{}})
 const before=index.forSession('s').revision;c.toolDiscovery=true;assert.notEqual(index.forSession('s').revision,before);index.close()
})
