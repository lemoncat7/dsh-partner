import test from 'node:test'
import assert from 'node:assert/strict'
import {observationModelFailure,withObservationModelRetry} from '../lib/observation-model-retry.js'
import {ObservationModelError} from '../lib/observation-errors.js'

const transient=()=>new ObservationModelError({code:'SERVER',message:'OpenAI API error (500): host_call_failed: utls: TLS handshake: EOF'})
test('model transport classification distinguishes transient, auth, input and rate limits',()=>{
 for(const error of [transient(),new Error('stream error: PROTOCOL_ERROR; received from peer'),{code:'ECONNRESET'}, {status:503}]) assert.equal(observationModelFailure(error).retryable,true)
 for(const error of [{status:401,message:'fetch failed'},{status:403},{status:400},{status:429},{name:'AbortError'},{code:'CERT_HAS_EXPIRED',message:'certificate has expired'},new Error('invalid JSON')])assert.equal(observationModelFailure(error).retryable,false)
 assert.equal(observationModelFailure(transient()).kind,'network')
 assert.equal(observationModelFailure({status:429}).kind,'rate_limited')
})
test('retry is bounded, reports metadata and shares the existing signal',async()=>{
 const signal=new AbortController().signal,delays=[],notices=[]
 let calls=0
 const result=await withObservationModelRetry(async()=>{calls++;if(calls<3)throw transient();return 'ok'}, {signal,wait:async(ms,s)=>{delays.push(ms);assert.equal(s,signal)},onRetry:r=>notices.push(r)})
 assert.equal(result,'ok');assert.equal(calls,3);assert.deepEqual(delays,[1000,3000]);assert.equal(notices.length,2)
 assert.equal(notices[0].status,500);assert.equal(JSON.stringify(notices).includes('host_call_failed'),false)
 calls=0
 await assert.rejects(withObservationModelRetry(async()=>{calls++;throw transient()},{signal,wait:async()=>{}}),/模型调用失败/)
 assert.equal(calls,3)
})
test('permanent failures and cancellation never retry',async()=>{
 let calls=0
 await assert.rejects(withObservationModelRetry(async()=>{calls++;throw {status:403}}, {signal:new AbortController().signal,wait:async()=>assert.fail('must not sleep')}))
 assert.equal(calls,1)
 const controller=new AbortController();calls=0
 await assert.rejects(withObservationModelRetry(async()=>{calls++;throw transient()},{signal:controller.signal,wait:async()=>{controller.abort();controller.signal.throwIfAborted()}}),/abort/i)
 assert.equal(calls,1)
})
