import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { PartnerStore } from '../lib/store.js'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('saving capabilities immediately recomposes live owned and restored sessions using the saved identity', async () => {
  const routes = ['owned', 'browser', 'closed'].map(id => ({ id, sessionId: id, companionId: 'manager' }))
  const calls = []
  const saved = { id: 'manager', capabilities: ['administration'] }
  const mock = {
    handles: new Map([['owned', {}]]), ctx: { agents: { get: id => id === 'browser' ? {} : undefined } },
    store: { snapshot: () => ({ sessions: routes, companions: [saved] }) },
    isCompanionBusy: () => false,
    async releaseCompanion(id) { calls.push(['release', id]) },
    async ensureAgent(companion, route) { calls.push(['compose', route.id, companion.capabilities]) },
  }
  await PartnerAgentRuntime.prototype.reloadCompanion.call(mock, 'manager')
  assert.deepEqual(calls, [['release', 'manager'], ['compose', 'owned', ['administration']], ['compose', 'browser', ['administration']]])
  saved.capabilities = []
  calls.length = 0
  await PartnerAgentRuntime.prototype.reloadCompanion.call(mock, 'manager')
  assert.deepEqual(calls.slice(1), [['compose', 'owned', []], ['compose', 'browser', []]])
})

test('capability refresh refuses to tear down an executing companion', async () => {
  await assert.rejects(PartnerAgentRuntime.prototype.reloadCompanion.call({ isCompanionBusy: () => true }, 'manager'), /正在执行/)
})

test('grant and revoke update the actual management tool in the same browser-owned agent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'partner-live-grant-'))
  const root = new Context()
  const carrier = {}
  const scope = createScope(root, carrier, { parent: {} })
  const store = await PartnerStore.open(join(directory, 'state.json'))
  const companion = store.snapshot().companions[0]
  const route = { id: 'live', kind: 'local', channelId: '@local', userId: companion.id, companionId: companion.id, sessionId: 'live-session', cwd: directory, lastMessageAt: 1 }
  await store.update(state => state.sessions.push(route))
  const registered = new Map()
  const sections = new Map()
  const agent = {
    status: 'idle', session: { id: route.sessionId, header: { cwd: directory }, events: [], seq: 0 },
    ctx: scope.ctx.extend({ agent: carrier,
      tools: { register(tool) { assert.equal(registered.has(tool.name), false); registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      systemPrompt: { section(value) { sections.set(value.name, value.text); return () => sections.delete(value.name) } },
    }),
    async whenIdle() {}, async runMaintenance(job) { return job(new AbortController().signal) },
  }
  const composition = new PartnerAgentComposition(store, { bindings: () => [] }, {}, { directoryFor: () => [] }, {}, {}, {}, {}, {})
  const ctx = root.extend({ agents: { get: id => id === route.sessionId ? agent : undefined }, workspaceRegistry: { archivedSessionIds: [], async create() { return { async attachSession() {} } } } })
  const runtime = new PartnerAgentRuntime(ctx, store, directory, undefined, undefined, undefined, composition)
  t.after(async () => { await runtime.close(); await scope.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.prepareSession(route.id)
  assert.equal(registered.has('partner_companion_manage'), false)
  await store.update(state => { state.companions[0].capabilities = ['administration']; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.ok(registered.has('partner_companion_manage'))
  assert.match(sections.get('partner-collaboration'), /knowledge_configure/)
  await store.update(state => { state.companions[0].capabilities = []; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.equal(registered.has('partner_companion_manage'), false)
  assert.doesNotMatch(sections.get('partner-collaboration'), /knowledge_configure/)
  assert.equal(ctx.agents.get(route.sessionId), agent)
  assert.equal(store.snapshot().sessions[0].sessionId, route.sessionId)
})
