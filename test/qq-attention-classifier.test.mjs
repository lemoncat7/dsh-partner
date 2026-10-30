import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {localAttentionClassifier} from '../lib/channels/qq/attention-classifier.js'
const signal=()=>new AbortController().signal
async function fixture(t,handler){
 const previous=process.env.DSH_PARTNER_ATTENTION_URL
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 process.env.DSH_PARTNER_ATTENTION_URL=`http://127.0.0.1:${server.address().port}`
 t.after(()=>{if(previous===undefined)delete process.env.DSH_PARTNER_ATTENTION_URL;else process.env.DSH_PARTNER_ATTENTION_URL=previous;server.closeAllConnections();server.close()})
 return localAttentionClassifier()
}
test('local classifier bounds text, validates output and never follows a redirect',async t=>{
 let mode='good',calls=0
 const classify=await fixture(t,(req,res)=>{calls++;let body='';req.on('data',data=>body+=data);req.on('end',()=>{
  assert.equal(req.url,'/classify');assert.ok(JSON.parse(body).text.length<=1200)
  if(mode==='good')res.end(JSON.stringify({label:'engage',confidence:.8,margin:.6}))
  else {res.writeHead(302,{Location:'http://127.0.0.1:1/private'});res.end()}
 })})
 assert.deepEqual(await classify('x'.repeat(2000),signal()),{label:'engage',confidence:.8,margin:.6})
 mode='redirect';assert.equal(await classify('hello',signal()),undefined)
 assert.equal(await classify('retry',signal()),undefined);assert.equal(calls,2,'failures open circuit instead of repeatedly stalling messages')
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
