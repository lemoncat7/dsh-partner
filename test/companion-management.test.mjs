import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { CompanionManagementService } from '../lib/companions/management.js'
import { CompanionKnowledgeMounts } from '../lib/companions/knowledge-mounts.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { normalizeCompanionDraft, createDefaultCompanion } from '../lib/domain.js'

const catalog = { presets: [{ id: 'worker', name: '工作预设' }, { id: 'broken', name: '坏预设', broken: 'missing' }], providers: [{ id: 'provider', models: [{ id: 'model' }] }] }
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'partner-management-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  await store.update(state => {
    const base = state.companions[0]
    state.companions = [
      { ...structuredClone(base), id: 'manager', name: '管理者', capabilities: ['administration'] },
      { ...structuredClone(base), id: 'worker', name: '研究员', instructions: '保留\n分行', capabilities: [] },
      { ...structuredClone(base), id: 'reviewer', name: '核验员', capabilities: [] },
    ]
    state.skills.push({ id: 'research', name: 'research', displayName: '研究', description: '资料研究', version: '1.0', source: 'local', rootPath: '/PRIVATE_SKILL_PATH', checksum: 'x', allowedTools: [], executionContext: 'fork', userInvocable: true, trusted: false, installedAt: 1, updatedAt: 1 })
    state.sessions.push({ id: 'route', kind: 'local', channelId: '@local', userId: 'owner', companionId: 'worker', sessionId: 'worker-session', cwd: '/partners/worker', lastMessageAt: 1 })
  })
  const reloaded = []
  const runtime = { catalog: async () => catalog, isBusy: () => false, reload: async id => { reloaded.push(id) }, ...overrides }
  const service = new CompanionManagementService(store, runtime)
  return { root, store, service, reloaded, runtime }
}

test('management defaults off, normalization accepts explicit user activation, and returned data omits private domains', async t => {
  const { service } = await fixture(t)
  assert.deepEqual(createDefaultCompanion().capabilities, [])
  assert.deepEqual(normalizeCompanionDraft({ name: '管理', capabilities: ['administration'] }).capabilities, ['administration'])
  await assert.rejects(service.catalog('worker'), /未获/)
  assert.throws(() => service.inspect('manager', 'manager'), /不能/)
  const info = service.inspect('manager', '@研究员')
  assert.equal(info.instructions, '保留\n分行')
  assert.equal('automation' in info, false)
  assert.equal('sessions' in info, false)
  assert.equal('channels' in info, false)
  const result = await service.catalog('manager')
  assert.equal(result.companions.find(item => item.id === 'manager').manageable, false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SKILL_PATH|checksum/)
})

test('one durable update changes identity, tool preset, skills and directed access without touching private state', async t => {
  const { service, store, reloaded, root } = await fixture(t)
  await store.update(state => {
    state.companions[1].automation.memory.enabled = true
    state.companions[1].automation.heartbeat.enabled = true
  })
  const initial = store.snapshot()
  const before = service.inspect('manager', 'worker')
  const result = await service.update('manager', 'worker', before.revision, {
    name: '高级研究员', instructions: '核对来源\n交付报告', capabilities: ['skills', 'knowledge', 'access'],
    presetId: 'worker', provider: 'provider', model: 'model', skillIds: ['research'], accessTargetIds: ['reviewer'],
  })
  assert.equal(result.applied, true)
  assert.equal(result.runtime, 'next-turn')
  assert.equal(result.companion.instructions, '核对来源\n交付报告')
  assert.equal(result.companion.presetId, 'worker')
  assert.deepEqual(result.companion.skillIds, ['research'])
  assert.deepEqual(result.companion.accessTargetIds, ['reviewer'])
  assert.notEqual(before.revision, result.companion.revision)
  assert.deepEqual(reloaded, ['worker'])
  const state = store.snapshot()
  assert.equal(state.companionAccessGrants.some(item => item.fromCompanionId === 'reviewer'), false)
  assert.deepEqual(state.sessions, initial.sessions)
  assert.deepEqual(state.channels, initial.channels)
  assert.deepEqual(state.companions[1].automation, initial.companions[1].automation)
  assert.equal((await PartnerStore.open(join(root, 'state.json'))).snapshot().companions[1].name, '高级研究员')
  const cleared = await service.update('manager', 'worker', result.companion.revision, { skillIds: [], accessTargetIds: [], presetId: '', provider: '', model: '' })
  assert.deepEqual(cleared.companion.skillIds, [])
  assert.deepEqual(cleared.companion.accessTargetIds, [])
  assert.equal(cleared.companion.presetId, undefined)
  assert.deepEqual(cleared.companion.capabilities, ['skills', 'knowledge', 'access'])
})

test('invalid or forbidden patches are atomic and cannot grant management authority', async t => {
  const { service, store } = await fixture(t)
  const before = store.snapshot()
  const revision = service.inspect('manager', 'worker').revision
  for (const patch of [
    { name: 'changed', capabilities: ['administration'] }, { capabilities: ['made-up'] },
    { name: 'changed', skillIds: ['missing'] }, { skillIds: ['research'] },
    { name: 'changed', accessTargetIds: ['missing'] }, { accessTargetIds: ['worker'] },
    { presetId: 'broken' }, { provider: 'provider', model: 'missing' },
    { automation: {} }, { channelId: 'secret' }, {},
  ]) await assert.rejects(service.update('manager', 'worker', revision, patch))
  assert.deepEqual(store.snapshot(), before)
  await store.update(state => { state.companions[1].capabilities = ['administration'] })
  await assert.rejects(service.update('manager', 'worker', service.inspect('manager', 'worker').revision, { capabilities: [] }), /只能由用户/)
})

test('revision checks include skill/access edits, and queued capability revocation wins over cached tools', async t => {
  const { service, store } = await fixture(t)
  const first = service.inspect('manager', 'worker')
  await store.update(state => state.skillBindings.push({ companionId: 'worker', skillId: 'research', enabled: true }))
  await assert.rejects(service.update('manager', 'worker', first.revision, { name: 'stale' }), /已变化/)
  const revision = service.inspect('manager', 'worker').revision
  const revoke = store.update(state => { state.companions[0].capabilities = [] })
  const update = service.update('manager', 'worker', revision, { name: 'blocked' })
  await revoke
  await assert.rejects(update, /未获/)
  assert.equal(store.snapshot().companions[1].name, '研究员')
})

test('busy targets are not interrupted; reload failures report committed state rather than a false rollback', async t => {
  const { service, store, runtime } = await fixture(t, { isBusy: () => true })
  const before = service.inspect('manager', 'worker')
  await assert.rejects(service.update('manager', 'worker', before.revision, { name: 'changed' }), /正在执行/)
  assert.equal(store.snapshot().companions[1].name, '研究员')
  runtime.isBusy = () => false
  runtime.reload = async () => { throw new Error('PRIVATE_STACK') }
  const result = await service.update('manager', 'worker', before.revision, { name: 'changed' })
  assert.equal(result.applied, true)
  assert.equal(result.runtime, 'next-turn')
  assert.doesNotMatch(result.warning, /PRIVATE_STACK/)
})

test('cancellation or revocation during asynchronous preset validation prevents the write', async t => {
  const { service, store, runtime } = await fixture(t)
  const revision = service.inspect('manager', 'worker').revision
  let release
  runtime.catalog = () => new Promise(resolve => { release = () => resolve(catalog) })
  const controller = new AbortController()
  const canceled = service.update('manager', 'worker', revision, { presetId: 'worker' }, controller.signal)
  controller.abort(new Error('canceled'))
  release()
  await assert.rejects(canceled, /canceled/)
  const revoked = service.update('manager', 'worker', revision, { presetId: 'worker' })
  await store.update(state => { state.companions[0].capabilities = [] })
  release()
  await assert.rejects(revoked, /未获/)
  assert.equal(store.snapshot().companions[1].presetId, undefined)
})

test('knowledge integration is optional, scopes targets on the server, and cannot edit arbitrary projects', async t => {
  const { service, store } = await fixture(t)
  const calls = []
  const bridge = { version: 1, catalog: async () => ({ bases: [] }), read: async scopes => ({ scopes, revision: 'mount-revision' }), configure: async (...args) => { calls.push(args); return { applied: true } } }
  const mounts = new CompanionKnowledgeMounts(store, service, () => bridge, id => '/partners/' + id)
  const info = await mounts.inspect('manager', 'worker')
  assert.deepEqual(info.scopes, [{ kind: 'project', id: '/partners/worker' }, { kind: 'session', id: 'worker-session' }])
  await mounts.configure('manager', 'worker', info.revision, { knowledgeBaseId: 'base', enabled: false })
  assert.equal(calls[0][2].enabled, false)
  assert.equal(calls[0][2].writeMode, 'audit')
  await assert.rejects(mounts.configure('manager', 'worker', info.revision, { knowledgeBaseId: 'base', targetId: '/other-project' }), /目标范围/)
  await assert.rejects(mounts.inspect('manager', 'manager'), /不能/)
  const missing = new CompanionKnowledgeMounts(store, service, () => undefined, id => id)
  await assert.rejects(missing.catalog('manager'), /新版知识库插件/)
  await store.update(state => { state.companions[0].capabilities = [] })
  await assert.rejects(mounts.configure('manager', 'worker', info.revision, { knowledgeBaseId: 'base' }), /未获/)
  assert.equal(calls.length, 1)
})

test('management tool is companion-scoped, absent without opt-in and checks live authorization on every call', async t => {
  const { store, service } = await fixture(t)
  const mounts = new CompanionKnowledgeMounts(store, service, () => undefined, id => id)
  const composition = new PartnerAgentComposition(store, { bindings: () => [] }, {}, { directoryFor: () => [] }, {}, {}, {}, service, mounts)
  const registered = new Map()
  const sections = []
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } }, systemPrompt: { section(value) { sections.push(value); return () => {} } } }
  const off = await composition.compose(ctx, store.snapshot().companions[1])
  assert.equal(registered.has('partner_companion_manage'), false)
  off()
  const on = await composition.compose(ctx, store.snapshot().companions[0])
  const tool = registered.get('partner_companion_manage')
  assert.ok(tool)
  assert.match(sections.at(-1).text, /知识库挂载/)
  const exec = { agent: { session: { id: 'manager-session' } }, signal: new AbortController().signal }
  await assert.rejects(tool.execute({ action: 'catalog' }, { signal: exec.signal }), /会话中调用/)
  assert.ok(JSON.parse(await tool.execute({ action: 'catalog' }, exec)).capabilities.length)
  await store.update(state => { state.companions[0].capabilities = [] })
  await assert.rejects(tool.execute({ action: 'catalog' }, exec), /已撤回/)
  on()
  assert.equal(registered.size, 0)
})

test('mount writes recheck revoked permission, target activity and scope after remote reads', async t => {
  const { service, store, runtime } = await fixture(t)
  let afterRead = async () => {}
  let writes = 0
  const bridge = {
    version: 1, catalog: async () => ({}), read: async () => ({}),
    configure: async (_targets, _revision, _settings, _signal, beforeWrite) => {
      await afterRead()
      beforeWrite()
      writes += 1
      return { applied: true }
    },
  }
  const mounts = new CompanionKnowledgeMounts(store, service, () => bridge, id => '/partners/' + id)
  afterRead = () => store.update(state => { state.companions[0].capabilities = [] })
  await assert.rejects(mounts.configure('manager', 'worker', 'revision', { knowledgeBaseId: 'base' }), /未获/)
  await store.update(state => { state.companions[0].capabilities = ['administration'] })
  afterRead = async () => { runtime.isBusy = () => true }
  await assert.rejects(mounts.configure('manager', 'worker', 'revision', { knowledgeBaseId: 'base' }), /正在执行/)
  runtime.isBusy = () => false
  afterRead = () => store.update(state => { state.sessions = [] })
  await assert.rejects(mounts.configure('manager', 'worker', 'revision', { knowledgeBaseId: 'base' }), /范围已变化/)
  assert.equal(writes, 0)
})

test('capability UI reuses existing tokens, labels and pressed state rather than introducing new controls', async () => {
  const source = await readFile(new URL('../src/ui/capability-editor.tsx', import.meta.url), 'utf8')
  assert.match(source, /title: CAPABILITY_LABELS.administration/)
  assert.match(source, /id: 'administration', eyebrow: 'ADMINISTRATION'/)
  assert.match(source, /不能自改或转授本权限/)
  assert.match(source, /aria-pressed=\{active\}/)
})
