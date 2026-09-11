import test from 'node:test'
import assert from 'node:assert/strict'
import { HeartbeatScheduler } from '../lib/heartbeat.js'

test('commits individual concerns, continues after failure and retries only unfinished work', async () => {
  const companion = { id: 'c', automation: { heartbeat: { enabled: true, intervalMinutes: 30, dailyLimit: 0 } } }
  const state = { companions: [companion], heartbeatStates: [],
    sessions: [{ companionId: 'c', channelId: 'w', userId: 'u', lastMessageAt: 0 }],
    channels: [{ id: 'w', enabled: true }], pairings: [{ channelId: 'w', userId: 'u', status: 'approved' }] }
  const saved = new Set(), calls = [], events = []
  let failing = true
  const concerns = {
    pendingNotifications: async () => [],
    due: async () => ['a', 'b', 'c'].filter(id => !saved.has(id)).map(id => ({ id, subject: id })),
    recordObservations: async items => {
      assert.equal(items.length, 1)
      saved.add(items[0].id); events.push('save:' + items[0].id)
      return { observations: [], notifications: [] }
    },
  }
  const scheduler = new HeartbeatScheduler({}, { snapshot: () => state, isCompanionRemoving: () => false, update: async fn => fn(state) }, {
    heartbeat: async (_companion, _route, items) => {
      assert.equal(items.length, 1)
      const id = items[0].id
      calls.push(id); events.push('run:' + id)
      if (id === 'b' && failing) throw Error('model unavailable')
      return { concerns: items, candidates: [], startedAt: 0, completedAt: 1 }
    },
    recordHeartbeatActivity: async () => {},
  }, {}, concerns)
  await assert.rejects(scheduler.trigger('c', { manual: true }), /model unavailable/)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.deepEqual(events, ['run:a', 'save:a', 'run:b', 'run:c', 'save:c'])
  assert.equal(state.heartbeatStates[0].consecutiveFailures, 1)
  failing = false
  const result = await scheduler.trigger('c', { manual: true })
  assert.equal(result.checked, true)
  assert.deepEqual(calls, ['a', 'b', 'c', 'b'])
  assert.equal(state.heartbeatStates[0].consecutiveFailures, 0)
  await scheduler.close()
})
