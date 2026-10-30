import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {createScope} from '@deepseek-ai/dsh-scope'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery,PARTNER_TOOL_ENTRIES} from '../lib/collaboration/tool-discovery.js'
import {installToolAccessGuard} from '../lib/execution/tool-access-adapter.js'
import {restrictExecutionTools} from '../lib/execution/operation-tool-access.js'
import {chatTools} from '../lib/chat/tools.js'
import {channelReplyPartsAfter} from '../lib/channels/delivery-policy.js'
import {createDefaultCompanion,normalizeCompanionDraft} from '../lib/domain.js'
import {SessionConfigurationIndex} from '../lib/companions/session-configuration.js'

function fixture(t){
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('discovery'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 const companion={id:'c',toolDiscovery:true},state={companions:[companion],channels:[],sessions:[{id:'local',kind:'local',companionId:'c',sessionId:agent.session.id,channelId:'local',userId:'owner'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false}
 const invoke=(name,args={},signal=new AbortController().signal)=>root.tools.execute({callId:'call-'+name,name,arguments:args,agent,signal})
 const call=(name,args={},signal)=>invoke('partner_tools',{action:'call',name,argumentsJson:JSON.stringify(args)},signal)
 t.after(()=>scope.dispose());return {root,agent,scope,store,state,companion,invoke,call}
}
const definition=(name,execute=async()=>({ok:true}))=>({name,description:'工具说明 '+name,parameters:{type:'object',properties:{text:{type:'string'}},additionalProperties:false},output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},timeoutMs:5000,execute})
const names=f=>f.root.tools.schemas(f.agent).filter(t=>PARTNER_TOOL_ENTRIES.includes(t.name)).map(t=>t.name).sort()

test('fixed entries describe and invoke original tools without registry churn; host policies still deny',async t=>{
 const f=fixture(t);let calls=0,changes=0
 const original=definition('partner_identity',async()=>{calls++;return {ok:true}})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:original,allowed:()=>true}]))
 t.after(f.root.on('tools/changed',()=>{changes++}))
 assert.deepEqual(names(f),['partner_channel_access','partner_tools'])
 const before=f.root.tools.schemas(f.agent)
 for(const action of ['describe','load','unload'])assert.equal((await f.invoke('partner_tools',{action,name:original.name})).isError,false)
 assert.equal(calls,0);assert.deepEqual(f.root.tools.schemas(f.agent),before);assert.equal(changes,0)
 const result=await f.call(original.name,{text:'x'});assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false);assert.equal(calls,1)
 f.scope.ctx.tools.guard(e=>e.name===original.name?'policy revoked':undefined)
 const denied=await f.call(original.name);assert.equal(denied.value.dispatch.isError,true);assert.equal(calls,1)
 assert.equal(f.root.tools.schemas().some(s=>s.name===original.name),false)
 const logs=f.agent.session.snapshotEvents().filter(e=>e.type==='tool/ptc-dispatch')
 assert.equal(logs.length,2);assert.equal(logs[1].data.isError,true)
})
test('QQ adapter lists only authorized abilities, changes identity without changing tools, and denies stale/nested calls',async t=>{
 const f=fixture(t);let calls=0
 const defs=['partner_identity','partner_chat_reply','partner_stickers','partner_qq_reply'].map(name=>definition(name,async()=>{calls++;return {ok:true}}))
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,defs.map(tool=>({tool,allowed:()=>true}))))
 t.after(f.scope.ctx.tools.register(definition('host_private')))
 t.after(installToolAccessGuard(f.root.tools,()=>f.state))
 f.state.channels=[{id:'qq',platform:'qq',qq:{identityBinding:{enabled:true,qqIds:['12345678']}}}]
 for(const [id,userId] of [['owner','12345678'],['guest','22345678']])f.state.sessions.push({id,kind:'channel',channelId:'qq',userId,companionId:'c',sessionId:f.agent.session.id,inboundMessageIds:[]})
 const send=id=>{const m=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]});f.agent.session.append('user/message',m,{surfaceOp:'append'});f.state.sessions.find(s=>s.id===id).inboundMessageIds.push(m.id)}
 const before=f.root.tools.schemas(f.agent)
 send('owner');let access=await f.invoke('partner_channel_access');assert.ok(access.value.tools.some(t=>t.name==='partner_identity'));assert.ok(access.value.tools.some(t=>t.name==='host_private'))
 assert.equal((await f.call('partner_identity')).value.dispatch.isError,false)
 send('guest');access=await f.invoke('partner_channel_access');assert.deepEqual(access.value.tools.map(t=>t.name).sort(),['partner_chat_reply','partner_qq_reply','partner_stickers'])
 assert.equal((await f.call('partner_identity')).isError,true);assert.equal((await f.invoke('partner_identity')).isError,true)
 assert.equal((await f.invoke('partner_tools',{action:'describe',name:'host_private'})).isError,true)
 assert.equal((await f.call('partner_chat_reply')).value.dispatch.isError,false)
 send('owner');assert.equal((await f.call('host_private')).value.dispatch.isError,false)
 f.state.channels[0].qq.identityBinding.qqIds=[];assert.equal((await f.call('host_private')).isError,true)
 assert.deepEqual(f.root.tools.schemas(f.agent),before);assert.equal(calls,2)
})
test('gateway preserves validation, cancellation, additional context and terminal reply metadata',async t=>{
 const f=fixture(t);let called=0
 const tool=definition('partner_test',async(_args,exec)=>{if('bad' in _args)throw Error('invalid arguments');called++;exec.deferContext(createUserMessage({source:{kind:'plugin:test'},content:[{type:'text',text:'context'}]}));exec.concludeTurn();return {ok:true}})
 tool.output.presentationMeta=()=>({kind:'original'})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool,allowed:()=>true}]))
 const invalid=await f.call(tool.name,{bad:1});assert.equal(invalid.value.dispatch.isError,true);assert.equal(called,0)
 const result=await f.call(tool.name);assert.equal(result.concludesTurn,true);assert.deepEqual(result.value.dispatch.meta,{kind:'original'});assert.equal(result.meta,undefined);assert.equal(result.additionalContexts.length,1)
 const canceled=await f.call(tool.name,{},AbortSignal.abort());assert.equal(canceled.isError,true);assert.equal(called,1)
})
test('chat reply through the gateway ends the turn and remains deliverable as native chat',async t=>{
 const f=fixture(t)
 f.companion.characterCard={enabled:true,segmentedReplies:true,stickersEnabled:true}
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,chatTools('c',f.store,{}, {},{},'/partner-local/v1').map(tool=>({tool,allowed:()=>true}))))
 f.agent.session.append('turn/start',{turn:1})
 f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'hello'}]}),{surfaceOp:'append'})
 const result=await f.call('partner_chat_reply',{messages:[{text:'好吧，被你抓到了。',stickerId:''}]})
 assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false);assert.equal(result.concludesTurn,true)
 assert.equal(result.meta,undefined,'only the nested event renders chat, preventing duplicate bubbles');assert.equal(result.value.dispatch.meta.kind,'partner-chat-v1');assert.deepEqual(result.value.dispatch.meta.parts,[{type:'text',text:'好吧，被你抓到了。'}])
 f.agent.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 assert.equal(channelReplyPartsAfter(f.agent.session.snapshotEvents(),0).chatParts[0].text,'好吧，被你抓到了。')
})
test('revoked catalogue entries and recursive gateway calls never execute',async t=>{
 const f=fixture(t);let allowed=true
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:definition('partner_test'),allowed:()=>allowed}]))
 allowed=false
 for(const name of ['partner_test','partner_tools','partner_channel_access','run_code'])assert.equal((await f.call(name)).isError,true)
 const listed=await f.invoke('partner_channel_access');assert.deepEqual(listed.value.tools,[])
 f.state.sessions=[];assert.equal((await f.invoke('partner_channel_access')).isError,true)
})
test('discovery setting remains validated and participates in next-turn composition revision',()=>{
 assert.throws(()=>normalizeCompanionDraft({name:'角色',toolDiscovery:'yes'}))
 const c={...createDefaultCompanion(),toolDiscovery:false},state={companions:[c],sessions:[{sessionId:'s',companionId:c.id}],skillBindings:[],companionAccessGrants:[],skills:[]}
 const index=new SessionConfigurationIndex({snapshot:()=>state,subscribe:()=>()=>{}})
 const before=index.forSession('s').revision;c.toolDiscovery=true;assert.notEqual(index.forSession('s').revision,before);index.close()
})

test('partner entry routes knowledge and SSH envelopes without bypassing operation allowlists',async t=>{
 const f=fixture(t),calls=[]
 for(const name of ['knowledge','ssh'])f.root.tools.register({name,description:name,
  parameters:{type:'object',properties:{action:{type:'string'},tool:{type:'string'},arguments:{type:'object',additionalProperties:true}},required:['action'],additionalProperties:false},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{assert.equal(exec.agent,f.agent);calls.push({name,args});return 'ok'},
 })
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[]))
 restrictExecutionTools(f.scope.ctx,f.agent,['partner_tools','knowledge_read','ssh_exec'])
 for(const [name,tool] of [['knowledge','knowledge_read'],['ssh','ssh_exec']]) {
  assert.equal((await f.call(name,{action:'list'})).value.dispatch.isError,false)
  assert.equal((await f.call(name,{action:'describe',tool})).value.dispatch.isError,false)
  assert.equal((await f.call(name,{action:'call',tool,arguments:{id:'fixture'}})).value.dispatch.isError,false)
 }
 const before=calls.length
 for(const [name,tool] of [['knowledge','knowledge_note_update'],['ssh','ssh_forward_start']])assert.equal((await f.call(name,{action:'call',tool,arguments:{}})).value.dispatch.isError,true)
 assert.equal((await f.call('ssh_exec',{})).isError,true,'old operation is not a top-level catalogue entry')
 assert.equal(calls.length,before)
 assert.deepEqual(calls.at(-1).args,{action:'call',tool:'ssh_exec',arguments:{id:'fixture'}})
 f.scope.ctx.tools.guard(exec=>exec.name==='ssh'?'host approval required':undefined)
 assert.equal((await f.call('ssh',{action:'call',tool:'ssh_exec',arguments:{}})).value.dispatch.isError,true)
 assert.equal(calls.length,before)
})

test('persona reference is discoverable and fully delivered through the two permanent tool entries',async t=>{
 const {identityTool}=await import('../lib/companions/identity-tool.js')
 const {ROLE_REFERENCE_TEXT}=await import('../lib/character/role-reference-data.js')
 const f=fixture(t);Object.assign(f.companion,createDefaultCompanion(),{id:'c'})
 t.after(installToolDiscovery(f.scope.ctx.tools,'c',f.store,[{tool:identityTool('c',f.store),allowed:()=>true}]))
 const found=await f.invoke('partner_tools',{action:'list',query:'大肥鱼'})
 assert.equal(found.value.tools[0].name,'partner_identity')
 const before=names(f),result=await f.call('partner_identity',{action:'reference'})
 assert.equal(result.isError,false);assert.equal(result.value.dispatch.isError,false)
 const data=JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join(''))
 assert.equal(data.reference.text,ROLE_REFERENCE_TEXT);assert.match(data.reference.text,/## 十、你的样子/)
 assert.deepEqual(names(f),before,'reference is on demand, not another permanent tool')
})
