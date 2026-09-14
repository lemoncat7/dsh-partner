import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForStorage, StorageStatusError } from '../lib/ui/storage-recovery.js'

test('recovery survives 504, 404 and running status then returns committed version',async()=>{
 const sequence=[504,404,{currentVersion:0,running:true},{currentVersion:1,targetVersion:1,running:false}]
 let waiting=0
 const result=await waitForStorage(new AbortController().signal,()=>waiting++,{delayMs:0,read:async()=>{const n=sequence.shift();if(typeof n==='number')throw new StorageStatusError(n);return n}})
 assert.equal(result.currentVersion,1);assert.equal(waiting,3)
})
test('ready old version is not mistaken for a completed migration',async()=>{
 const result=await waitForStorage(new AbortController().signal,()=>{}, {read:async()=>({currentVersion:0,targetVersion:1,running:false,lastError:'copy failed'})})
 assert.equal(result.currentVersion,0);assert.equal(result.lastError,'copy failed')
})
test('recovery is bounded, auth failures stop, and unmount abort cancels waits',async()=>{
 let reads=0
 await assert.rejects(waitForStorage(new AbortController().signal,()=>{}, {delayMs:0,attempts:2,read:async()=>{reads++;throw new StorageStatusError(404)}}),/尚未恢复/)
 assert.equal(reads,2)
 await assert.rejects(waitForStorage(new AbortController().signal,()=>{}, {read:async()=>{throw new StorageStatusError(401)}}),/登录/)
 const controller=new AbortController()
 await assert.rejects(waitForStorage(controller.signal,()=>controller.abort(),{read:async()=>({running:true})}),{name:'AbortError'})
})
