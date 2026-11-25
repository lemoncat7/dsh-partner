import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {Session} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {agentEvents} from '@deepseek-ai/dsh-agent'
import {createScope} from '@deepseek-ai/dsh-scope'
import {installMalformedToolRetry,malformedToolName} from '../lib/execution/malformed-tool-retry.js'

const raw='{"messages":[{"text":"文件好了"，"delivery":"text"}]}'
const failure={code:'MALFORMED_RESPONSE',message:'Tool call "partner_chat_reply": Expected comma in JSON\n\nReceived arguments:\n'+raw}
test('only model tool JSON syntax failures qualify, without repairing or executing their contents',()=>{
 assert.equal(malformedToolName(failure),'partner_chat_reply')
 for(const value of [{...failure,code:'INVALID_ARGS'},{...failure,code:'SERVER'},{...failure,message:'invalid JSON from an HTTP response'},{...failure,message:failure.message.replace(raw,'{"messages":[]}')}])assert.equal(malformedToolName(value),undefined)
})
test('native request-error retries twice in the same step, feeds back correction and preserves prior successful work',async t=>{
 const root=new Context(),session=Session.create('partner-retry'),agent={id:session.id,session,inbox:{nextStep:[],nextTurn:[]}}
 const scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 session.append('turn/start',{turn:1})
 session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'做完后台工作后告诉我'}]}),{surfaceOp:'append'})
 session.append('tool/call',{callId:'existing',name:'partner_background_task',arguments:'{"action":"start"}'})
 session.append('tool/result',{message:{role:'tool',id:'result',toolCallId:'existing',source:{kind:'tool',callId:'existing'},content:[{type:'text',text:'taskId=already-running'}],isError:false}},{surfaceOp:'append'})
 const before=session.snapshotEvents()
 const stop=installMalformedToolRetry(root,value=>value===agent);t.after(stop)
 let delegated=0
 const attempt=(extra={})=>agentEvents(root,agent).waterfall('agent/request-error',{turn:1,step:2,provider:'fake',failure,signal:new AbortController().signal,...extra},async()=>{delegated++;return undefined})
 assert.deepEqual(await attempt(),{kind:'retry'});assert.deepEqual(await attempt(),{kind:'retry'})
 assert.equal(await attempt(),undefined);assert.equal(delegated,1)
 assert.deepEqual(session.snapshotEvents().slice(0,before.length),before)
 assert.equal(session.snapshotEvents().filter(event=>event.type==='tool/call').length,1,'no earlier task or send is replayed')
 const corrections=session.deriveMessages().filter(message=>message.source.kind==='plugin:@lemoncat7/dsh-partner')
 assert.equal(corrections.length,2)
 assert.match(corrections[0].content[0].text,/标准 JSON/);assert.doesNotMatch(corrections[0].content[0].text,/文件好了/)
 assert.deepEqual(await attempt({step:3}),{kind:'retry'})
 stop();assert.equal(await attempt({step:4}),undefined)
})
test('cancellation, foreign agents and newer user steering are never retried',async t=>{
 const root=new Context(),agent={id:'a',session:Session.create('a'),inbox:{nextStep:[],nextTurn:[]}}
 const scope=createScope(root,agent);agent.ctx=scope.ctx;t.after(()=>scope.dispose())
 let eligible=true;const stop=installMalformedToolRetry(root,()=>eligible);t.after(stop)
 const attempt=signal=>agentEvents(root,agent).waterfall('agent/request-error',{turn:1,step:1,provider:'fake',failure,signal},async()=>undefined)
 assert.equal(await attempt(AbortSignal.abort()),undefined)
 eligible=false;assert.equal(await attempt(new AbortController().signal),undefined)
 eligible=true;agent.inbox.nextStep.push(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'先停一下'}]}))
 assert.equal(await attempt(new AbortController().signal),undefined)
 assert.equal(agent.session.snapshotEvents().length,0)
})
