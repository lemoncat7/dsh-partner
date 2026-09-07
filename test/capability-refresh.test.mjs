import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { PartnerStore } from '../lib/store.js'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function fixture(t, makeComposer) {
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
  let compositions = 0
  let disposals = 0
  const agent = {
    status: 'running', session: { id: route.sessionId, header: { cwd: directory }, events: [], seq: 0 },
    ctx: scope.ctx.extend({ agent: carrier,
      tools: { register(tool) { assert.equal(registered.has(tool.name), false); registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      systemPrompt: { section(value) { assert.ok(!sections.has(value.name), 'no duplicate prompt sections'); sections.set(value.name, value.text); return () => sections.delete(value.name) } },
    }),
    async whenIdle() { throw new Error('pre-step must not wait for itself') },
    async runMaintenance() { throw new Error('pre-step must not schedule maintenance') },
  }
  const composition = new PartnerAgentComposition(store, { bindings: () => [] }, {}, { directoryFor: () => [] }, {}, {}, {}, {}, {})
  const composer = makeComposer?.({ store, registered, sections }) ?? composition
  const ctx = root.extend({
    agents: { get: id => id === route.sessionId ? agent : undefined },
    workspaceRegistry: { archivedSessionIds: [], async create() { return { async attachSession() {} } } },
  })
  const runtime = new PartnerAgentRuntime(ctx, store, directory, undefined, undefined, undefined, {
    async compose(...args) { compositions++; const dispose = await composer.compose(...args); return () => { disposals++; dispose() } },
  })
  t.after(async () => { await runtime.close(); await scope.dispose(); await rm(directory, { recursive: true, force: true }) })
  const step = (turn, signal = new AbortController().signal) => ctx.waterfall(scopeTarget(carrier), 'agent/pre-step', { agent, turn, signal }, async () => 'ready')
  return { runtime, store, agent, route, companion, registered, sections, step, counts: () => ({ compositions, disposals }) }
}

test('native browser resume installs tools before the first turn without /prepare, unchanged turns do not recompose', async t => {
  const { step, registered, counts, runtime, agent } = await fixture(t)
  assert.equal(registered.size, 0)
  assert.equal(await step(1), 'ready')
  assert.ok(registered.has('partner_task_board'))
  await step(1)
  await step(2)
  assert.deepEqual(counts(), { compositions: 1, disposals: 0 })
  await runtime.prepareAgentTurn({ session: { id: 'ordinary-session' } }, 1, new AbortController().signal)
  assert.deepEqual(counts(), { compositions: 1, disposals: 0 })
  assert.equal(agent.status, 'running')
})

test('activity-only writes do not recompose but peer grants and identity changes do', async t => {
  const { step, store, companion, counts } = await fixture(t)
  await step(1)
  await store.update(state => { state.sessions[0].lastMessageAt += 1; state.companions[0].updatedAt += 1 })
  await step(2)
  assert.equal(counts().compositions, 1)
  await store.update(state => {
    state.companions.push({ ...state.companions[0], id: 'peer', name: '同伴' })
    state.companionAccessGrants.push({ fromCompanionId: companion.id, toCompanionId: 'peer', createdAt: 1 })
  })
  await step(3)
  assert.equal(counts().compositions, 2)
  await store.update(state => { state.companions[1].role = '新的公开职责' })
  await step(4)
  assert.equal(counts().compositions, 3)
})

test('closing while a composition is pending cleans effects instead of installing after shutdown', async t => {
  let entered
  let release
  const began = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  let disposed = 0
  const { runtime, step, sections } = await fixture(t, () => ({ async compose() {
    entered(); await barrier; return () => { disposed++ }
  } }))
  const pending = step(1)
  await began
  const rejected = assert.rejects(pending, /已关闭/)
  const close = runtime.close()
  release()
  await rejected
  await close
  assert.equal(sections.size, 0)
  assert.equal(disposed, 1)
})

test('grant is deferred to next turn and revoke blocks an old management tool immediately', async t => {
  const { runtime, store, companion, route, agent, registered, sections, step, counts } = await fixture(t)
  await step(1)
  assert.equal(registered.has('partner_companion_manage'), false)
  await store.update(state => { state.companions[0].capabilities = ['administration']; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.equal(registered.has('partner_companion_manage'), false)
  await step(1)
  assert.equal(registered.has('partner_companion_manage'), false)
  await step(2)
  assert.ok(registered.has('partner_companion_manage'))
  assert.match(sections.get('partner-collaboration'), /knowledge_configure/)
  const oldTool = registered.get('partner_companion_manage')
  await store.update(state => { state.companions[0].capabilities = []; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.ok(registered.has('partner_companion_manage'))
  await assert.rejects(oldTool.execute({ action: 'catalog' }, {}), /已撤回/)
  await step(2)
  assert.ok(registered.has('partner_companion_manage'))
  await step(3)
  assert.equal(registered.has('partner_companion_manage'), false)
  assert.doesNotMatch(sections.get('partner-collaboration'), /knowledge_configure/)
  assert.equal(agent.session.id, route.sessionId)
  assert.equal(store.snapshot().sessions[0].sessionId, route.sessionId)
  assert.deepEqual(counts(), { compositions: 3, disposals: 2 })
})

test('composition failure blocks the turn, cleans partial sections and retries without duplicates', async t => {
  let fail = true
  const { step, sections, counts } = await fixture(t, () => ({ async compose() { if (fail) throw new Error('compose failed'); return () => {} } }))
  await assert.rejects(step(1), /compose failed/)
  assert.equal(sections.size, 0)
  fail = false
  await step(1)
  assert.equal(sections.size, 2)
  assert.deepEqual(counts(), { compositions: 2, disposals: 0 })
})

test('all opt-in partner tools reject calls from the old schema after revocation', async t => {
  const { store, step, registered } = await fixture(t)
  await store.update(state => { state.companions[0].capabilities = ['skills', 'companions', 'access', 'administration', 'schedules'] })
  await step(1)
  const names = ['partner_skill', 'partner_companions', 'partner_access_grants', 'partner_companion_manage', 'partner_schedule']
  const tools = names.map(name => { assert.ok(registered.has(name)); return registered.get(name) })
  await store.update(state => { state.companions[0].capabilities = [] })
  for (const tool of tools) await assert.rejects(tool.execute({}, {}), /已撤回/)
  await step(2)
  for (const name of names) assert.equal(registered.has(name), false)
  assert.ok(registered.has('partner_task_board'), 'shared board is not gated by an unrelated capability')
})

test('save during asynchronous composition is not marked as already applied', async t => {
  let release
  let began
  const entered = new Promise(resolve => { began = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  let first = true
  const seen = []
  const { step, store } = await fixture(t, () => ({ async compose(ctx, companion) {
    seen.push(companion.instructions)
    if (first) { first = false; began(); await barrier }
    return () => {}
  } }))
  const running = step(1)
  await entered
  await store.update(state => { state.companions[0].instructions = 'new identity' })
  release()
  await running
  assert.notEqual(seen[0], 'new identity')
  await step(1)
  assert.equal(seen.length, 1)
  await step(2)
  assert.equal(seen[1], 'new identity')
})

test('cancellation cleans new effects and does not mark the failed turn prepared', async t => {
  const controller = new AbortController()
  let disposed = 0
  let first = true
  const { step, sections } = await fixture(t, () => ({ async compose() {
    if (first) { first = false; controller.abort(new Error('cancelled')) }
    return () => { disposed++ }
  } }))
  await assert.rejects(step(1, controller.signal), /cancelled/)
  assert.equal(disposed, 1)
  assert.equal(sections.size, 0)
  await step(1)
  assert.equal(sections.size, 2)
})
