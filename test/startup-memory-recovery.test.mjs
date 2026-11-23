import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { recoverStartupConversationMemory } from '../lib/startup-memory-recovery.js'

test('default startup never reads old sessions or allocates a history snapshot', async () => {
  const config = resolveConfig({statePath:'/tmp/partner-startup-memory-test'})
  assert.equal(config.recoverConversationMemoryOnStart, false)
  await recoverStartupConversationMemory(config.recoverConversationMemoryOnStart,
    {snapshot(){throw Error('startup must not read state')}},
    {recoverConversationMemory(){throw Error('startup must not open history')}},
  )
})

test('explicit catch-up processes companions sequentially and only snapshots their configuration', async () => {
  const calls = [], done = []
  const config = resolveConfig({statePath:'/tmp/partner-startup-memory-test',recoverConversationMemoryOnStart:true})
  await recoverStartupConversationMemory(config.recoverConversationMemoryOnStart,
    {snapshot(keys){assert.deepEqual(keys,['companions']);return {companions:[{id:'first'},{id:'second'}]}}},
    {async recoverConversationMemory(id){calls.push(id);assert.equal(done.length,calls.length-1);await Promise.resolve();done.push(id);return 0}},
  )
  assert.deepEqual(done,['first','second'])
})

test('enabled catch-up surfaces a failure without starting subsequent histories', async () => {
  const calls=[]
  await assert.rejects(recoverStartupConversationMemory(true,
    {snapshot(){return {companions:[{id:'first'},{id:'second'}]}}},
    {async recoverConversationMemory(id){calls.push(id);throw Error('recovery failed')}},
  ),/recovery failed/)
  assert.deepEqual(calls,['first'])
})
