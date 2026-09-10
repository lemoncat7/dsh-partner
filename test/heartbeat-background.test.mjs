import test from 'node:test'
import assert from 'node:assert/strict'
import { HeartbeatScheduler } from '../lib/heartbeat.js'

function fixture() {
  const store = {snapshot: () => ({companions: [{id:'c'}]}), isCompanionRemoving: () => false}
  return new HeartbeatScheduler({}, store, {}, {}, {})
}

test('manual trigger returns immediately and deduplicates until completion', async () => {
  const scheduler = fixture()
  let finish; let calls = 0
  scheduler.run = () => { calls++; return new Promise(resolve => {finish = resolve}) }
  assert.equal(scheduler.startManual('c').accepted, true)
  assert.equal(scheduler.manualStatus('c').running, true)
  assert.equal(scheduler.startManual('c').accepted, false)
  assert.equal(calls, 1)
  finish({checked:true,sent:false,reason:'没有变化'})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(scheduler.manualStatus('c'), {running:false,result:{checked:true,sent:false,reason:'没有变化'}})
})

test('background failure is consumed, unlocks and is not reported as successful', async () => {
  const scheduler = fixture()
  scheduler.run = async () => {throw new Error('test failure')}
  scheduler.startManual('c')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(scheduler.manualStatus('c').running, false)
  assert.equal(scheduler.manualStatus('c').result.checked, false)
  assert.match(scheduler.manualStatus('c').result.reason, /受阻/)
  assert.throws(() => scheduler.startManual('missing'), /不存在/)
  await scheduler.close()
  assert.throws(() => scheduler.startManual('c'), /停止/)
})
