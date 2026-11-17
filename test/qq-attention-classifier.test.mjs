import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {localAttentionClassifier} from '../lib/channels/qq/attention-classifier.js'
const signal=()=>new AbortController().signal
async function fixture(t,handler,now){
 const previous=process.env.DSH_PARTNER_ATTENTION_URL
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 process.env.DSH_PARTNER_ATTENTION_URL=`http://127.0.0.1:${server.address().port}`
 t.after(()=>{if(previous===undefined)delete process.env.DSH_PARTNER_ATTENTION_URL;else process.env.DSH_PARTNER_ATTENTION_URL=previous;server.closeAllConnections();server.close()})
 return localAttentionClassifier(now)
}
test('local classifier bounds text, validates output and never follows a redirect',async t=>{
 let mode='good',calls=0
 const classify=await fixture(t,(req,res)=>{calls++;let body='';req.on('data',data=>body+=data);req.on('end',()=>{
  assert.equal(req.url,'/classify');assert.ok(JSON.parse(body).text.length<=1200)
  if(mode==='good')res.end(JSON.stringify({label:'engage',confidence:.8,margin:.6}))
  else {res.writeHead(302,{Location:'http://127.0.0.1:1/private'});res.end()}
 })})
 assert.deepEqual(await classify('x'.repeat(2000),signal()),{label:'engage',confidence:.8,margin:.6})
 const beforeRedirect=calls
 mode='redirect';assert.equal(await classify('hello',signal()),undefined)
 assert.ok(calls>beforeRedirect&&calls<=beforeRedirect+2,'redirect fails within the bounded attempt budget')
 const afterRedirect=calls
 assert.equal(await classify('retry',signal()),undefined);assert.equal(calls,afterRedirect,'failures open circuit instead of repeatedly stalling messages')
})
test('four classifications run independently; overflow falls back without waiting',async t=>{
 const responses=[]
 const classify=await fixture(t,(_req,res)=>responses.push(res))
 const pending=Array.from({length:4},(_,i)=>classify('group '+i,signal()))
 while(responses.length<4)await new Promise(r=>setTimeout(r,5))
 assert.equal(await classify('overflow',signal()),undefined)
 for(const res of responses)res.end(JSON.stringify({label:'engage',confidence:.8,margin:.6}))
 assert.equal((await Promise.all(pending)).filter(Boolean).length,4)
})
test('aborted classification is not converted into a decision to reply',async t=>{
 let entered
 const classify=await fixture(t,()=>{entered=true})
 const controller=new AbortController(),pending=classify('hello',controller.signal)
 while(!entered)await new Promise(r=>setTimeout(r,5))
 controller.abort();await assert.rejects(pending)
})

test('slow local classification has a short budget and does not stall the next message',async t=>{
 let calls=0
 const classify=await fixture(t,()=>{calls++})
 const start=performance.now();assert.equal(await classify('需要判断的群聊',signal()),undefined)
 assert.ok(performance.now()-start<2000,'classification uses a single bounded cold-start budget')
 const next=performance.now();assert.equal(await classify('后续补充',signal()),undefined)
 assert.ok(performance.now()-next<100);assert.equal(calls,1,'a timeout must not duplicate inference in the single-worker queue')
})

test('context is bounded separately from current intent, optional similarity is validated, and legacy responses still work',async t=>{
 let n=0
 const classify=await fixture(t,(req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
  const data=JSON.parse(body);assert.equal(data.text,'当前消息');assert.equal(data.context.length,4);assert.ok(data.context.every(t=>t.length<=48))
  res.end(JSON.stringify({label:'engage',confidence:.55,margin:.2,...(n++===0?{contextSimilarity:.7}:{contextSimilarity:2})}))
 })})
 const context=Array.from({length:10},(_,i)=>String(i)+'x'.repeat(300))
 assert.equal((await classify('当前消息',signal(),context)).contextSimilarity,.7)
 assert.equal((await classify('当前消息',signal(),context)).contextSimilarity,undefined)
})

test('a transient dropped connection is retried once and success clears the outage state',async t=>{
 let calls=0,diagnostic
 const classify=await fixture(t,(req,res)=>{calls++;if(calls===1)req.socket.destroy();else res.end(JSON.stringify({label:'address',confidence:.6,margin:.3}))})
 assert.equal((await classify('继续接话',signal(),[],d=>{diagnostic=d})).label,'address')
 assert.deepEqual(diagnostic,{status:'ok',attempts:2});assert.equal(calls,2)
 assert.ok(await classify('下一条',signal()));assert.equal(calls,3)
})
test('one failed request does not disable recognition for thirty seconds; retry backoff is bounded',async t=>{
 let now=1000,calls=0,good=false,diagnostic
 const classify=await fixture(t,(_req,res)=>{calls++;if(good)res.end(JSON.stringify({label:'engage',confidence:.7,margin:.4}));else {res.writeHead(503);res.end() }},()=>now)
 assert.equal(await classify('第一条',signal(),[],d=>{diagnostic=d}),undefined);assert.equal(diagnostic.retryAfterMs,1000)
 await classify('紧接着',signal(),[],d=>{diagnostic=d});assert.equal(diagnostic.status,'backoff');assert.equal(calls,1)
 now+=1000;good=true;assert.ok(await classify('恢复后',signal(),[],d=>{diagnostic=d}));assert.equal(diagnostic.status,'ok');assert.equal(calls,2)
})


test('a cold inference slower than the old 450ms budget succeeds without retrying',async t=>{
 let calls=0,diagnostic
 const classify=await fixture(t,(_req,res)=>{calls++;setTimeout(()=>res.end(JSON.stringify({label:'address',confidence:.8,margin:.6})),700)})
 assert.equal((await classify('弟弟，你在吗',signal(),[],d=>{diagnostic=d})).label,'address');assert.equal(calls,1);assert.equal(diagnostic.attempts,1)
})

test('scene protocol bounds verified profile independently and rejects malformed optional metadata',async t=>{
 let n=0
 const classify=await fixture(t,(req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
  const body=JSON.parse(raw);assert.equal(body.frame.profile.length,3);assert.ok(body.frame.profile.every(s=>s.length<=160));assert.equal(body.frame.partnerText.length,160)
  res.end(JSON.stringify({label:'engage',confidence:.8,margin:.6,replySimilarity:n?2:.7,profileSimilarity:.5,scene:n++?{label:'invented',confidence:1,margin:1}:{label:'banter',confidence:.8,margin:.6}}))
 })})
 const frame={profile:Array(5).fill('x'.repeat(300)),partnerText:'y'.repeat(300)}
 const result=await classify('当前内容',signal(),[],undefined,frame)
 assert.deepEqual(result.scene,{label:'banter',confidence:.8,margin:.6});assert.equal(result.replySimilarity,.7);assert.equal(result.profileSimilarity,.5)
 const invalid=await classify('下一条',signal(),[],undefined,frame);assert.equal(invalid.scene,undefined);assert.equal(invalid.replySimilarity,undefined)
})
