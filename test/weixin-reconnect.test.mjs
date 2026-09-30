import test from 'node:test'
import assert from 'node:assert/strict'
import { pollWeixin } from '../lib/channels/weixin/poll.js'
import { WeixinApi } from '../lib/channels/weixin/api.js'
import { WeixinHttpError, weixinTransientFailure } from '../lib/channels/weixin/errors.js'

test('successful empty long poll establishes connection without a first message', async () => {
  const controller = new AbortController(), states = []
  await pollWeixin(controller.signal, {
    getUpdates: async () => ({ ret: 0, msgs: [] }),
    state: value => states.push(value),
    receive: () => controller.abort(),
  })
  assert.deepEqual(states, [{ status: 'running' }])
})

test('network failures beyond six reconnect, preserve cursor and clear stale error', async () => {
  const controller = new AbortController(), states = [], delays = [], buffers = [], received = []
  let calls = 0
  await pollWeixin(controller.signal, {
    async getUpdates(buffer) {
      buffers.push(buffer); calls++
      if (calls === 1) return { get_updates_buf: 'cursor-1', msgs: [{ message_id: 'first' }] }
      if (calls <= 10) throw new TypeError('fetch failed')
      return { get_updates_buf: 'cursor-2', msgs: [{ message_id: 'second' }] }
    },
    state: state => states.push(state),
    wait: async ms => { delays.push(ms) },
    receive: response => { received.push(response.msgs[0].message_id); if (received.length === 2) controller.abort() },
  })
  assert.equal(calls, 11)
  assert.equal(delays.length, 9)
  assert.ok(delays.every(ms => ms > 0 && ms <= 60000))
  assert.ok(buffers.slice(1).every(b => b === 'cursor-1'))
  assert.deepEqual(received, ['first', 'second'])
  assert.deepEqual(states.at(-1), { status: 'running' })
  assert.match(states[1].lastError, /自动重连/)
})

test('authentication failures stop without retry; do not display remote response secrets', async () => {
  for (const failure of [new WeixinHttpError(401), new WeixinHttpError(403), { errcode: -14, errmsg: 'secret-token' }, { ret: -14 }]) {
    let waits = 0
    await assert.rejects(pollWeixin(new AbortController().signal, {
      getUpdates: async () => { if (failure instanceof Error) throw failure; return failure },
      receive() {}, state() {}, wait: async () => { waits++ },
    }), /重新扫码/)
    assert.equal(waits, 0)
  }
})

test('retry-after is honored and user stop interrupts backoff without another poll', async () => {
  const controller = new AbortController()
  let calls = 0
  await pollWeixin(controller.signal, {
    getUpdates: async () => { calls++; throw new WeixinHttpError(429, 90000) },
    state() {}, receive() {},
    wait: async (ms, signal) => { assert.equal(ms, 90000); assert.equal(signal, controller.signal); controller.abort(); throw new Error('aborted') },
  })
  assert.equal(calls, 1)
  for (const status of [408, 429, 500, 502, 503]) assert.equal(weixinTransientFailure(new WeixinHttpError(status)), true)
  assert.equal(weixinTransientFailure(new DOMException('timeout', 'TimeoutError')), true)
  assert.equal(weixinTransientFailure(new WeixinHttpError(404)), false)
})

test('unknown persistent protocol failures remain bounded', async () => {
  let calls = 0
  await assert.rejects(pollWeixin(new AbortController().signal, {
    getUpdates: async () => { calls++; return { errcode: 123, errmsg: 'secret-token' } },
    state() {}, receive() {}, wait: async () => {},
  }), error => /非网络错误/.test(error.message) && !error.message.includes('secret-token'))
  assert.equal(calls, 6)
})

test('HTTP API retains status and retry-after but excludes arbitrary response body', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret-token', { status: 429, headers: { 'retry-after': '120' } }))
  await assert.rejects(new WeixinApi().getUpdates('', 35000, new AbortController().signal), error => {
    assert.ok(error instanceof WeixinHttpError)
    assert.equal(error.retryAfterMs, 120000)
    assert.equal(error.status, 429)
    assert.ok(!error.message.includes('secret-token'))
    return true
  })
})
