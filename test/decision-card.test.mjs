import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { decisionDefinition, DecisionCard, registerDecisionCards } from '../lib/decision/conversation.js'

const state = { id: 'decision-1', requestId: 2, status: 'running', reason: 'running', durationMs: 0, suggestions: [] }
const start = { event: { type: 'partner/decision', seq: 4, data: state }, role: 'start', location: { kind: 'turn', turn: { status: 'open' } } }
const context = { key: 'partner-decision:1', id: state.id, kind: 'partner-decision', start, matches: [start], state }

for (const version of ['published-rc2', 'new-runtime']) test(`registers the card on ${version} service, not only component rendering`, () => {
  const registrations = [], cleanups = []
  const registry = { register(definition) { registrations.push(definition); return () => registrations.pop() } }
  const services = version === 'published-rc2' ? { uiConversation: { events: registry } } : { conversationEvents: registry }
  let renderer
  const ctx = {
    get(name) { return services[name] },
    effect(factory) { cleanups.push(factory()) },
    inject(names, callback) { if (names.every(name => services[name])) callback(ctx) },
    slots: { inject(name, callback) { assert.equal(name, 'conversation.chat.node'); callback() },
      register(options, component) { assert.equal(options.key, 'partner-decision'); renderer = component; return () => {} } },
  }
  registerDecisionCards(ctx)
  assert.deepEqual(registrations, [decisionDefinition])
  const data = decisionDefinition.start(context, start)
  const node = decisionDefinition.buildViewNode({ ...context, state: data })
  assert.match(renderToStaticMarkup(renderer({ node })), /自动决策/)
  cleanups.forEach(dispose => dispose())
  assert.equal(registrations.length, 0)
})

test('one stable card is updated by settled evidence, without tool-call impersonation', () => {
  assert.equal(decisionDefinition.match({ type: 'tool/call' }), null)
  assert.equal(decisionDefinition.match(start.event).id, state.id)
  const settled = { ...state, status: 'settled', reason: 'recommended', durationMs: 200, suggestions: ['工具：{"id":"read","name":"读取"}'] }
  const next = decisionDefinition.update(context, { event: { data: settled } })
  const node = decisionDefinition.buildViewNode({ ...context, state: next })
  assert.equal(node.key, context.key)
  assert.equal(node.anchorSeq, 4)
  assert.equal(node.kind, 'partner-decision')
  const html = renderToStaticMarkup(createElement(DecisionCard, { data: node.data }))
  assert.match(html, /自动决策/)
  assert.match(html, /已推荐（未执行）/)
  assert.match(html, /工具：读取/)
  assert.doesNotMatch(html, /&quot;id&quot;/)
})

test('closed or recovered interrupted turns cannot leave a permanent running card', () => {
  const node = decisionDefinition.buildViewNode({ ...context, start: { ...start, location: { kind: 'turn', turn: { status: 'closed' } } } })
  assert.equal(node.data.reason, 'interrupted')
  assert.equal(node.data.status, 'settled')
})

test('a loaded settled event can initialize the card without its earlier running event', () => {
  const data = { ...state, status: 'settled', reason: 'timeout', durationMs: 15000 }
  assert.equal(decisionDefinition.start({}, { event: { data } }), data)
  assert.match(renderToStaticMarkup(createElement(DecisionCard, { data })), /超时，已回退原有流程/)
})
