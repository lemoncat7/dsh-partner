import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskProgressNotifier } from '../lib/tasks/progress-notifier.js'

test('persisted final result is delivered before a blocked internal follow-up', async () => {
  const order = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const notify = createTaskProgressNotifier(async () => { order.push('channel') }, async () => { order.push('internal'); await blocked }, () => assert.fail('unexpected failure'))
  const task = { id: 'fixture', status: 'done' }
  const pending = notify(task, 'review')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['channel', 'internal'])
  release(); await pending
})

test('channel and follow-up failures remain independent and are reported', async () => {
  const calls = [], warnings = []
  const notify = createTaskProgressNotifier(async () => { calls.push('channel'); throw new Error('channel offline') }, async () => { calls.push('internal'); throw new Error('agent unavailable') }, message => warnings.push(message))
  await notify({ id: 'fixture', status: 'done' }, 'review')
  assert.deepEqual(calls, ['channel', 'internal'])
  assert.match(warnings[0], /channel offline/)
  assert.match(warnings[1], /agent unavailable/)
})
