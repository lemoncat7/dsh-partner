import test from 'node:test'
import assert from 'node:assert/strict'
import {ReplyQueue} from '../lib/core/reply-queue.js'
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:v=>resolve(v)}}
test('a hundred speakers collapse to the latest opportunity; explicit work runs first',async()=>{
 const q=new ReplyQueue(),gate=deferred(),seen=[]
 const active=q.enqueue('s','ordered',undefined,()=>gate.promise,()=>null)
 await Promise.resolve()
 const pending=Array.from({length:100},(_,i)=>q.enqueue('s','ambient','room',async()=>{seen.push(i);return i},()=>null))
 const task=q.enqueue('s','direct','room',async()=>{seen.push('task');return 'task'},()=>null)
 gate.resolve('active');await Promise.all([active,task,...pending]);await q.idle('s')
 assert.deepEqual(seen,['task']);assert.equal(q.busy('s'),false)
})
test('explicit requests stay FIFO; other rooms retain their latest chatter',async()=>{
 const q=new ReplyQueue(),gate=deferred(),seen=[]
 const all=[q.enqueue('s','ordered',undefined,()=>gate.promise,()=>null)]
 await Promise.resolve()
 for(const [kind,room,id] of [['ambient','b','old'],['direct','a','first'],['ambient','b','latest'],['direct','a','second']])all.push(q.enqueue('s',kind,room,async()=>seen.push(id),()=>null))
 gate.resolve();await Promise.all(all);assert.deepEqual(seen,['first','second','latest'])
})
test('actual work protects its room and errors release the lane',async()=>{
 const q=new ReplyQueue(),gate=deferred(),seen=[]
 const active=q.enqueue('s','ambient','a',()=>gate.promise,()=>null);await Promise.resolve()
 const old=q.enqueue('s','ambient','a',async()=>seen.push('old'),()=>null)
 q.protect('s');const fresh=q.enqueue('s','ambient','a',async()=>seen.push('fresh'),()=>null)
 const other=q.enqueue('s','ambient','b',async()=>seen.push('other'),()=>null)
 gate.resolve();await Promise.all([active,old,fresh,other]);assert.deepEqual(seen,['other'])
 await assert.rejects(q.enqueue('s','ordered',undefined,async()=>{throw Error('failure')},()=>null))
 assert.equal(await q.enqueue('s','ordered',undefined,async()=>42,()=>null),42);await q.idle('s');assert.equal(q.busy('s'),false)
})
test('independent sessions run concurrently and pending chatter is bounded per room',async()=>{
 const q=new ReplyQueue(),gate=deferred()
 const first=q.enqueue('s1','ordered',undefined,()=>gate.promise,()=>null)
 assert.equal(await q.enqueue('s2','direct','r',async()=>99,()=>null),99)
 gate.resolve();await first
})

test('runtime retains slow current input, skips superseded opportunities and releases idle tracking',async()=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const route={sessionId:'session',userId:'group:12345678:22334455',channelId:'qq'},state={channels:[{id:'qq',platform:'qq'}],sessions:[route],companions:[]}
 const runtime=new PartnerAgentRuntime({}, {snapshot:()=>state,subscribe:()=>()=>{}},'/tmp')
 runtime.ensureSession=async()=>route;runtime.cancelPostReply=async()=>{};let calls=0
 runtime.drive=async()=>{calls++;return {text:'done',attachments:[]}}
 const c={id:'c'}
 const current=Object.assign(()=>{},{groupCurrent:()=>true}),superseded=Object.assign(()=>{},{groupCurrent:()=>false})
 assert.equal((await runtime.reply(c,'qq',route.userId,{text:'slow',attachments:[],groupReply:{kind:'ambient',receivedAt:Date.now()-60000}},current)).text,'done')
 assert.equal((await runtime.reply(c,'qq',route.userId,{text:'replaced',attachments:[],groupReply:{kind:'ambient',receivedAt:Date.now()-60000}},superseded)).text,'')
 assert.equal(calls,1)
 assert.equal((await runtime.reply(c,'qq',route.userId,{text:'explicit task',attachments:[],groupReply:{kind:'direct',receivedAt:Date.now()-60000}})).text,'done')
 await runtime.replyQueue.idle('session');assert.equal(runtime.queues.size,0);assert.equal(calls,2)
})

test('completed background gets the next foreground slot without interrupting the active reply',async()=>{
 const q=new ReplyQueue(),gate=deferred(),seen=[]
 const active=q.enqueue('s','ordered',undefined,async()=>{seen.push('active');await gate.promise;seen.push('finished')},()=>null);await Promise.resolve()
 const chatter=q.enqueue('s','ambient','room',async()=>seen.push('chatter'),()=>null)
 const user=q.enqueue('s','direct','room',async()=>seen.push('user'),()=>null)
 const done=q.enqueue('s','delivery',undefined,async()=>seen.push('completion'),()=>null)
 assert.deepEqual(seen,['active']);gate.resolve();await Promise.all([active,chatter,user,done]);assert.deepEqual(seen,['active','finished','completion','user'])
})

test('steering waits for the admitted photo to enter the session before checking its origin',async()=>{
 const {PartnerAgentRuntime}=await import('../lib/agent-runtime.js')
 const runtime=new PartnerAgentRuntime({}, {snapshot:()=>({sessions:[],channels:[],companions:[]}),subscribe:()=>()=>{}},'/tmp')
 const start=deferred(),finish=deferred(),sender='group:12345678:22334455',c={id:'c'}
 runtime.enqueueReply=async(_c,_ch,_u,_message,_progress,inputReady)=>{start.resolve(inputReady);await finish.promise;return {text:'done',attachments:[]}}
 runtime.ensureSession=async()=>({sessionId:'session'})
 runtime.cancelPostReply=async()=>{}
 const seen=[]
 runtime.deliverSteering=async(_c,_ch,user,message)=>{seen.push([user,message.text]);return true}
 const first=runtime.reply(c,'qq',sender,{text:'photo',attachments:[],groupReply:{kind:'direct',receivedAt:Date.now()}})
 const inputReady=await start.promise
 const caption=runtime.steer(c,'qq',sender,{text:'caption',attachments:[]})
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(seen,[])
 inputReady();assert.equal(await caption,true);assert.deepEqual(seen,[[sender,'caption']])
 finish.resolve();await first;assert.equal(runtime.preparingGroupInputs.size,0)
})
