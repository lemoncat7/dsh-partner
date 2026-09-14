import test from 'node:test'
import assert from 'node:assert/strict'
import {pollDiscovered} from '../lib/channels/direct/discovery.js'

test('encrypted invitations produce a notice without joining or pairing',async()=>{
  let calls=0
  const batch=await pollDiscovered('matrix','bot',undefined,new AbortController().signal,async()=>{
    calls++
    return {next_batch:'next',rooms:{invite:{secret:{invite_state:{events:[{type:'m.room.encryption'}]}}}}}
  },()=>assert.fail('must not validate or enter encrypted invitation'))
  assert.match(batch.warning,/加密/)
  assert.deepEqual(batch.messages,[])
  assert.equal(calls,1)
})

for(const source of ['state','ciphertext','validation'])test(`encryption detected from ${source} does not block a plaintext room`,async()=>{
  const encrypted=source==='state'?{state:{events:[{type:'m.room.encryption'}]},timeline:{events:[]}}:{timeline:{events:[{type:source==='ciphertext'?'m.room.encrypted':'m.room.message'}]}}
  const batch=await pollDiscovered('matrix','bot','previous',new AbortController().signal,async()=>({next_batch:'next',rooms:{join:{secret:encrypted,plain:{timeline:{events:[{type:'m.room.message',sender:'alice',event_id:'msg',content:{msgtype:'m.text',body:'hello'}}]}}}}}),id=>({validate:async()=>{
    if(id==='secret')throw Error('检测到 Matrix 加密房间')
    return {accountId:'bot',peerId:'alice'}
  }}))
  assert.match(batch.warning,/只有未加密/)
  assert.deepEqual(batch.messages,[{id:'msg',sender:'alice',targetId:'plain',text:'hello'}])
  assert.equal(batch.cursor,'next')
})
