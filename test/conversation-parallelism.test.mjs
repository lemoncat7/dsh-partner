import test from 'node:test'
import assert from 'node:assert/strict'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {AsyncSemaphore} from '../lib/core/semaphore.js'
const tick=()=>new Promise(r=>setImmediate(r))
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(){
 const runtime=new PartnerAgentRuntime({}, {snapshot:()=>({sessions:[],companions:[],channels:[]}),subscribe:()=>()=>{}}, '/tmp')
 runtime.ensureSession=async(_c,_channel,user)=>({sessionId:user.startsWith('shared')?'main':user})
 runtime.cancelPostReply=async()=>{}
 return runtime
}
test('independent sessions progress while one is blocked; shared actual sessions remain ordered',async()=>{
 const runtime=fixture(),first=gate(),calls=[]
 runtime.drive=async(_c,_ch,user)=>{calls.push(user);if(user==='shared-a')await first.promise;return {text:user,attachments:[]}}
 const a=runtime.reply({id:'c'},'ch','shared-a',{text:'a',attachments:[]})
 await tick()
 const b=runtime.reply({id:'c'},'ch','shared-b',{text:'b',attachments:[]})
 const other=runtime.reply({id:'c'},'ch','independent',{text:'c',attachments:[]})
 await other
 assert.deepEqual(calls,['shared-a','independent'])
 first.resolve();await Promise.all([a,b]);assert.deepEqual(calls,['shared-a','independent','shared-b'])
})
test('failed replies release the session lane',async()=>{
 const runtime=fixture();let attempts=0
 runtime.drive=async()=>{if(!attempts++)throw Error('model failed');return {text:'recovered',attachments:[]}}
 await assert.rejects(runtime.reply({id:'c'},'ch','a',{text:'a',attachments:[]}))
 assert.equal((await runtime.reply({id:'c'},'ch','a',{text:'b',attachments:[]})).text,'recovered')
})
test('semaphore transfers a reserved slot without admitting an extra newcomer',async()=>{
 const slots=new AsyncSemaphore(2);let active=0,max=0
 await Promise.all(Array.from({length:40},()=>slots.use(async()=>{max=Math.max(max,++active);await tick();active--})))
 assert.equal(max,2);assert.equal(active,0)
})
