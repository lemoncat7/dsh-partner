import test from 'node:test'
import assert from 'node:assert/strict'
import { questionOrigin } from '../lib/channels/question-origin.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { DirectTransport } from '../lib/channels/direct/transport.js'

const message = id => ({ type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: 'same text' }] } })
function fixture(platform = 'weixin') {
  const route = { id: 'route', kind: 'channel', companionId: 'c', sessionId: 's', channelId: 'channel', userId: 'peer', inboundMessageIds: ['inbound'] }
  const channel = { id: 'channel', companionId: 'c', platform, enabled: true, accountId: 'bot', direct: { baseUrl: 'http://localhost', targetId: 'room' } }
  const state = { channels: [channel], sessions: [{ ...route, id: 'local', kind: 'local', inboundMessageIds: [] }, route], pairings: [{ channelId: 'channel', userId: 'peer', status: 'approved', directTargetId: 'room' }], recentReceipts: [] }
  const store = { snapshot: () => structuredClone(state), update: async fn => fn(state) }
  const manager = new ChannelManager({ logger: { warn() {} } }, store, { read: async () => ({ baseUrl: 'http://localhost', botToken: 'token' }) }, {}, '/tmp')
  const controller = new AbortController()
  const request = { agent: { session: { id: 's', snapshotEvents: () => [message('inbound')] } }, questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }], signal: controller.signal }
  return { manager, state, route, channel, request, controller }
}

test('source follows exact latest message, not session binding, identical text or most recent channel', () => {
  const { state, route } = fixture()
  assert.equal(questionOrigin('s', [message('inbound')], state.sessions).id, route.id)
  assert.equal(questionOrigin('s', [message('inbound'), message('browser')], state.sessions), undefined)
  assert.equal(questionOrigin('other-session', [message('inbound')], state.sessions), undefined)
  const matrix = { ...route, id: 'matrix', channelId: 'matrix', inboundMessageIds: ['matrix-msg'] }
  assert.equal(questionOrigin('s', [message('inbound'), message('matrix-msg')], [...state.sessions, matrix]).id, 'matrix')
  assert.equal(questionOrigin('s', [message('matrix-msg'), message('inbound')], [...state.sessions, matrix]).id, 'route')
  assert.equal(questionOrigin('s', [message('legacy-untracked')], state.sessions), undefined)
  assert.equal(questionOrigin('s', [message('inbound')], JSON.parse(JSON.stringify(state.sessions))).channelId, 'channel')
})

test('browser questions delegate to native UI despite a WeChat-bound route', async () => {
  const { manager, route, request } = fixture()
  request.agent.session.snapshotEvents = () => [message('inbound'), message('browser')]
  manager.sender = () => assert.fail('must not send')
  assert.equal(await manager.askThroughChannel(route, request, async () => 'native'), 'native')
})

test('WeChat question accepts only the original channel and peer', async () => {
  const f = fixture(), sent = []
  f.manager.sender = () => ({ sendText: async (...args) => { sent.push(args) } })
  const answer = f.manager.askThroughChannel(f.route, f.request, async () => assert.fail('must stay in originating channel'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.length, 1)
  assert.equal(await f.manager.answerPendingQuestion('s', '1', { ...f.channel, id: 'another' }, {}, 'peer', f.request.signal), false)
  assert.equal(await f.manager.answerPendingQuestion('s', '1', f.channel, {}, 'other-user', f.request.signal), false)
  assert.equal(await f.manager.answerPendingQuestion('s', '1', f.channel, {}, 'peer', f.request.signal), true)
  assert.deepEqual((await answer).answers[0].selected, ['A'])
  assert.equal(f.manager.pendingQuestions.size, 0)
})

for (const platform of ['matrix', 'mattermost']) test(`${platform} receives answers independently while the main reply loop is waiting`, async () => {
  const f = fixture(platform), events = []
  const api = new DirectTransport({ platform, baseUrl: 'http://localhost', targetId: 'room' }, 'token')
  api.poll = async cursor => { events.push(cursor ? 'receive' : 'watermark'); return { cursor: 'next', messages: cursor ? [{ id: 'reply', sender: 'peer', text: '2' }] : [] } }
  api.sendText = async () => { events.push('send') }
  f.manager.sender = () => api
  const answer = await f.manager.askThroughChannel(f.route, f.request, async () => assert.fail('must not fall back to DSH'))
  assert.deepEqual(events, ['watermark', 'send', 'receive'])
  assert.deepEqual(answer.answers[0].selected, ['B'])
  assert.ok(f.state.recentReceipts.includes('channel:reply'))
  assert.equal(f.manager.pendingQuestions.size, 0)
})

test('channel stop cancels pending questions; delivery failure never silently reroutes', async () => {
  const f = fixture()
  f.manager.sender = () => ({ sendText: async () => {} })
  const pending = f.manager.askThroughChannel(f.route, f.request, async () => assert.fail('not native'))
  const rejected = assert.rejects(pending, /停止/)
  await new Promise(resolve => setImmediate(resolve))
  await f.manager.stop('channel'); await rejected
  assert.equal(f.manager.pendingQuestions.size, 0)
  f.manager.sender = () => ({ sendText: async () => { throw new Error('network unavailable') } })
  await assert.rejects(f.manager.askThroughChannel(f.route, f.request, async () => assert.fail('not native')), /network unavailable/)
  assert.equal(f.manager.pendingQuestions.size, 0)
})

test('revoked pairing cannot receive a question', async () => {
  const f = fixture(); f.state.pairings[0].status = 'blocked'
  f.manager.sender = () => assert.fail('must not send')
  await assert.rejects(f.manager.askThroughChannel(f.route, f.request, async () => assert.fail('not native')), /授权已失效/)
})
