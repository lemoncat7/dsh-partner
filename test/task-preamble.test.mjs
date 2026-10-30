import test from 'node:test'
import assert from 'node:assert/strict'
import {TaskPreambleGate,installTaskPreamble,needsTaskPreamble} from '../lib/execution/task-preamble.js'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createScope} from '@deepseek-ai/dsh-scope'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installToolDiscovery} from '../lib/collaboration/tool-discovery.js'
const user=id=>({type:'user/message',data:{id,source:{kind:'user'}}})
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('silent tool-only task is blocked until persona-authored acknowledgement is delivered',async()=>{
 const events=[{type:'turn/start'},user('u')],sent=[],delivery=gate()
 const g=new TaskPreambleGate(()=>events,async text=>{sent.push(text);await delivery.promise})
 assert.match(await g.before('generate_image',{}),/尚未执行/)
 const ack=g.acknowledge('醒啦，我这就画给你。')
 let released=false;const work=g.before('generate_image',{}).then(result=>{assert.equal(result,undefined);released=true})
 await new Promise(r=>setImmediate(r));assert.equal(released,false)
 delivery.resolve();await Promise.all([ack,work]);assert.equal(released,true)
 await g.acknowledge('不应该再发一条');assert.deepEqual(sent,['醒啦，我这就画给你。'])
 assert.equal(await g.before('web_search',{}),undefined)
 events.push(user('u2'));assert.match(await g.before('generate_image',{}),/尚未执行/)
})
test('visible tool preamble is sent and awaited; failed or revoked delivery never releases work',async()=>{
 const events=[{type:'turn/start'},user('u'),{type:'assistant/message',data:{message:{content:[{type:'text',text:'我去核实一下。'},{type:'tool-call',name:'web_search'}]}}}]
 const sent=[],g=new TaskPreambleGate(()=>events,async text=>{sent.push(text)})
 assert.equal(await g.before('web_search',{}),undefined);assert.deepEqual(sent,['我去核实一下。'])
 let attempts=0;const failed=new TaskPreambleGate(()=>events,async()=>{attempts++;throw Error('unknown send')})
 assert.match(await failed.before('web_search',{}),/未确认送达/)
 assert.match(await failed.before('web_search',{}),/发送失败/);assert.equal(attempts,1)
})
test('discovery and ordinary chat stay immediate; autonomous/internal turns never require an acknowledgement',async()=>{
 for(const name of ['partner_chat_reply','partner_stickers','partner_tools','partner_chat_progress'])assert.equal(needsTaskPreamble(name,{}),false)
 assert.equal(needsTaskPreamble('ssh',{action:'describe'}),false)
 const events=[{type:'turn/start'},{type:'user/message',data:{id:'notice',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice'}}}]
 const g=new TaskPreambleGate(()=>events,async()=>assert.fail('must not send'))
 assert.equal(await g.before('generate_image',{}),undefined);await assert.rejects(g.acknowledge('hello'))
})
test('real unified entry blocks image execution, delivers progress without concluding, then executes exactly once',async t=>{
 const root=new Context();root.provide('systemPrompt',{tools:()=>()=>{}});new ToolRuntime(root)
 const agent={session:Session.create('preamble'),options:{}},scope=createScope(root,agent);agent.ctx=scope.ctx
 t.after(()=>scope.dispose())
 const state={companions:[{id:'c',toolDiscovery:true}],channels:[],sessions:[{id:'local',kind:'local',companionId:'c',sessionId:agent.session.id}]}
 t.after(installToolDiscovery(scope.ctx.tools,'c',{snapshot:()=>state,isCompanionRemoving:()=>false},[]))
 let executions=0;const sent=[]
 t.after(scope.ctx.tools.register({name:'generate_image',description:'generate',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},execute:async()=>{executions++;return {files:['real.png']}}}))
 const dispose=installTaskPreamble(agent,async text=>sent.push(text));t.after(dispose)
 agent.session.append('turn/start',{turn:1})
 agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'画张图'}]}),{surfaceOp:'append'})
 let seq=0
 const call=(name,args={})=>root.tools.execute({name:'partner_tools',arguments:{action:'call',name,argumentsJson:JSON.stringify(args)},agent,signal:new AbortController().signal,callId:'call-'+seq++})
 const blocked=await call('generate_image');assert.equal(blocked.value.dispatch.isError,true);assert.equal(executions,0)
 const ack=await call('partner_chat_progress',{text:'等着，我来画。'});assert.equal(ack.value.dispatch.isError,false);assert.ok(!ack.concludesTurn);assert.deepEqual(sent,['等着，我来画。'])
 const image=await call('generate_image');assert.equal(image.value.dispatch.isError,false);assert.equal(executions,1)
 dispose();assert.equal(scope.ctx.tools.get('partner_chat_progress',agent),undefined)
})

test('a shared-session input from another route cannot send through the previous channel',async()=>{
 const events=[{type:'turn/start'},user('u')];let active=true
 const delivery=gate(),sent=[]
 const g=new TaskPreambleGate(()=>events,async text=>{sent.push(text);await delivery.promise},()=>active)
 const ack=g.acknowledge('我先去看看。');active=false;delivery.resolve()
 await assert.rejects(ack,/输入/)
 await assert.rejects(g.acknowledge('不能发到旧会话'))
 assert.equal(await g.before('generate_image',{}),undefined)
 assert.deepEqual(sent,['我先去看看。'])
})
