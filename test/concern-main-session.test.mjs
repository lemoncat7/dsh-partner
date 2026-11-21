import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { channelReplyTextAfter } from '../lib/channels/delivery-policy.js'
import { CONCERN_EXECUTION_NOTICE } from '../lib/concern-notification.js'

test('concern notices append only to the partner main conversation, including when it shares a channel', async () => {
  const companion = { id: 'c' }
  const main = { id: 'web', kind: 'local', companionId: 'c', channelId: '@local', userId: 'owner:c', sessionId: 'main' }
  const source = { id: 'qq', kind: 'channel', companionId: 'c', channelId: 'qq', userId: 'member', sessionId: 'other' }
  const linked = { ...source, id: 'shared-qq', sessionId: 'main' }
  const state = { sessions: [source, linked, main], companions: [companion], channels: [], pairings: [] }
  const store = { snapshot: () => state, isCompanionRemoving: () => false }
  const session = Session.create(main.sessionId)
  const runtime = Object.assign(Object.create(PartnerAgentRuntime.prototype), {
    store, isArchived: () => false,
    ensureLocalSessionRecord: async () => main,
    ensureAgent: async (_c, route) => {
      assert.equal(route.id, main.id)
      return { session, status: 'idle' }
    },
  })
  const channel = Object.assign(Object.create(ChannelManager.prototype), {
    store, agents: runtime, deliverNotification: async () => assert.fail('no configured or recent recipient'),
    routeForSession: () => linked,
  })
  assert.equal(await runtime.recordConcernCreatedNotice(companion, 'qq:member', [{ subject: '版本更新' }]), true)
  await runtime.recordConcernNotification(companion, { id: 'change', event: '有新版本' })
  await runtime.recordConcernNotification(companion, { id: 'change', event: '有新版本' })
  const events = session.snapshotEvents()
  assert.equal(events.length, 2)
  for (const event of events) await channel.observeAutonomousResult(session, event)
  assert.equal(events.at(-1).data.content[0].text, '有新版本')

  state.sessions = [source, linked]
  await assert.rejects(runtime.recordConcernNotification(companion, { id: 'next', event: '再次更新' }), /主会话已变化/)
  assert.equal(session.snapshotEvents().length, 2)
})

test('concern notification recipients come from settings, even when the main conversation is bound to a QQ group', async () => {
  const qqGroup = { channelId: 'qq', userId: 'group:12345678:22334455' }
  const latest = { channelId: 'qq', userId: '22334455' }
  const selected = { channelId: 'weixin', userId: 'owner' }
  const companion = { id: 'c', notificationDelivery: { mode: 'selected', targets: [selected] } }
  const main = { kind: 'local', companionId: 'c', sessionId: 'main' }
  const group = { ...qqGroup, kind: 'channel', companionId: 'c', sessionId: 'main' }
  const state = {
    sessions: [group, main], companions: [companion],
    channels: [{ id:'qq', companionId:'c', platform:'qq', enabled:true }, { id:'weixin', companionId:'c', enabled:true }],
    pairings: [selected, latest, qqGroup].map((target, index) => ({...target, status:'approved', lastInboundAt:index+1})),
  }
  const sent = []
  const manager = Object.assign(Object.create(ChannelManager.prototype), {
    store: { snapshot: () => state, isCompanionRemoving: () => false },
    agents: { isArchived: () => false },
    deliverNotification: async (_id, receipt, targets, reply) => sent.push({receipt, targets:targets(), text:reply.text}),
  })
  const created = {
    type: 'user/message', seq: 2,
    data: { content:[{type:'text', text:'新增关注'}], source: {kind:'plugin:@lemoncat7/dsh-partner', plugin:'@lemoncat7/dsh-partner', form:'notice', summary:'伙伴自动新增关注'} },
  }
  await manager.observeAutonomousResult({ id:'other-session' }, created)
  await manager.observeAutonomousResult({ id:'main' }, created)
  assert.deepEqual(sent, [{receipt:'concern-created:main:2', targets:[selected], text:'新增关注'}])
  companion.notificationDelivery = { mode:'recent', targets:[] }
  await manager.notifyConcern('c', '有变化', 'change')
  delete companion.notificationDelivery
  await manager.notifyConcern('c', '继续关注', 'default')
  assert.deepEqual(sent.slice(1).map(row=>row.targets), [[latest],[latest]])
})

test('watch execution following a channel reply is excluded from that channel reply', () => {
  const answer = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
  const event = (seq, type, data) => ({ seq, type, data })
  const events = [
    event(1, 'turn/start', {}),
    event(2, 'user/message', { source: { kind: 'user' } }),
    event(3, 'assistant/message', { message: answer('正常渠道回复') }),
    event(4, 'turn/end', { reason: { kind: 'completed' } }),
    event(5, 'turn/start', {}),
    event(6, 'user/message', { source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: CONCERN_EXECUTION_NOTICE } }),
    event(7, 'assistant/message', { message: answer('持续关注结果') }),
    event(8, 'turn/end', { reason: { kind: 'completed' } }),
  ]
  assert.equal(channelReplyTextAfter(events, 0), '正常渠道回复')
})
