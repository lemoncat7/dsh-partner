import test from 'node:test'
import assert from 'node:assert/strict'
import { isPluginSource, PARTNER_SOURCE_KIND } from '../lib/message-source.js'
import { isInternalTaskNotice, isAutonomousDeliveryTurn } from '../lib/channels/delivery-policy.js'
import { busyEnterMode } from '../lib/channels/manager.js'

test('rc.2 producer sources and historical wrappers preserve internal-notice silence', () => {
  for (const source of [
    { kind: PARTNER_SOURCE_KIND, form: 'notice', summary: '伙伴执行看板任务' },
    { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴执行看板任务' },
  ]) {
    assert.equal(isPluginSource(source, '@lemoncat7/dsh-partner'), true)
    assert.equal(isInternalTaskNotice({ type: 'user/message', data: { source } }), true)
  }
  assert.equal(isPluginSource({ kind: 'plugin:another-plugin' }, '@lemoncat7/dsh-partner'), false)
  const goal = { type: 'user/message', data: { source: { kind: 'tool-goal', form: 'notice', summary: 'complete: compatibility check' } } }
  assert.equal(isAutonomousDeliveryTurn([goal]), true)
  const board = { type: 'user/message', data: { source: { kind: PARTNER_SOURCE_KIND, form: 'notice', summary: '伙伴执行看板任务' } } }
  assert.equal(isAutonomousDeliveryTurn([board, goal]), false)
})

test('channel delivery reads the live host config descriptor each round', () => {
  let mode = 'queue'
  const settings = { describe: () => [{ ns: 'ui-conversation', value: { busyEnter: mode } }] }
  assert.equal(busyEnterMode(settings), 'queue')
  mode = 'steer'
  assert.equal(busyEnterMode(settings), 'steer')
  assert.equal(busyEnterMode(undefined), 'queue')
})
