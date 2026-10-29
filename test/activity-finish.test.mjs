import test from 'node:test'
import assert from 'node:assert/strict'
import {idleActivityFinishTool,isSilentActivityResult} from '../lib/character/activity-tool.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
function fixture(t){
 const events=[{type:'user/message',seq:0,data:{id:'u',source:{kind:'user'}}},{type:'turn/start',seq:1},{type:'user/message',seq:2,data:{id:'a',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}}]
 const state={companions:[{id:'c',idleContact:{enabled:true,routeId:'r'}}],sessions:[{id:'r',kind:'local',companionId:'c',sessionId:'s',idleContactState:{messageId:'a',userMessageId:'u'}}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false},root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:{id:'s',header:{},snapshotEvents:()=>events},options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 scope.ctx.tools.register(idleActivityFinishTool('c',store))
 const invoke=()=>root.tools.execute({callId:'a',name:'partner_activity_finish',arguments:{reason:'暂时没有想做的事'},agent,signal:new AbortController().signal})
 return {state,events,invoke}
}
test('silent completion preserves terminal metadata through the real runtime',async t=>{
 const f=fixture(t);f.events.push({type:'user/message',seq:3,data:{id:'context',source:{kind:'plugin:system-prompt',form:'snapshot',sections:[]}}});const result=await f.invoke();assert.equal(result.isError,false);assert.equal(result.concludesTurn,true)
 assert.equal(isSilentActivityResult({type:'tool/result',data:{message:{isError:false},meta:result.meta}}),true)
 assert.equal(isSilentActivityResult({type:'tool/result',data:{message:{isError:true},meta:result.meta}}),false)
})
for(const change of ['user','task','revoked','stale','foreign'])test('cannot suppress '+change+' turns',async t=>{
 const f=fixture(t)
 if(change==='user')f.events.push({type:'user/message',seq:3,data:{id:'u2',source:{kind:'user'}}})
 if(change==='task')f.events.push({type:'user/message',seq:3,data:{id:'t',source:{kind:'plugin:task'}}})
 if(change==='revoked')f.state.companions[0].idleContact.enabled=false
 if(change==='stale')f.state.sessions[0].idleContactState.messageId='newer'
 if(change==='foreign')f.state.sessions[0].companionId='other'
 const result=await f.invoke();assert.equal(result.isError,true);assert.notEqual(result.concludesTurn,true)
})
