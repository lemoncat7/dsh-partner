import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { CompanionService } from '../lib/companions/service.js'
import { removeOwnedWorkspace } from '../lib/companions/workspace-cleanup.js'
import { assertOwnedDirectory, removeOwnedDirectory } from '../lib/companions/directory-cleanup.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-removal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  await store.update(state => state.companions.push({ ...state.companions[0], id: 'other', name: '其他伙伴' }))
  const calls = []
  const lifecycle = { isBusy: () => false, ...Object.fromEntries(['detachWorkspace', 'resetSessions', 'clearMemory', 'clearConcerns'].map(name => [name, async id => { calls.push([name, id]) }])) }
  return { root, store, calls, lifecycle, service: new CompanionService(store) }
}

test('companion deletion clears owned references and cancels waiting work', async t => {
  const { store, service, lifecycle, calls } = await fixture(t)
  await store.update(state => {
    state.sessions.push({ id: 'route', companionId: 'other', sessionId: 'session', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
    state.tasks.push({ id: 'task', assigneeCompanionId: 'other', reviewerCompanionId: 'other', autoRun: true, revision: 1 })
    state.delegations.push({ id: 'job', toCompanionId: 'other', status: 'queued', taskId: 'task' })
  })
  await service.remove('other', lifecycle)
  assert.equal(store.snapshot().companions.length, 1)
  assert.equal(store.snapshot().sessions.length, 0)
  assert.equal(store.snapshot().tasks[0].assigneeCompanionId, undefined)
  assert.equal(store.snapshot().tasks[0].autoRun, false)
  assert.equal(store.snapshot().delegations[0].status, 'canceled')
  assert.deepEqual(calls.map(([name]) => name), ['detachWorkspace', 'resetSessions', 'clearMemory', 'clearConcerns'])
})

test('concurrent deletion cannot delete the last companion or repeat cleanup', async t => {
  const { store, service, lifecycle, calls } = await fixture(t)
  const results = await Promise.allSettled([service.remove('other', lifecycle), service.remove('companion-default', lifecycle), service.remove('other', lifecycle)])
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'rejected', 'rejected'])
  assert.equal(store.snapshot().companions[0].id, 'companion-default')
  assert.equal(calls.length, 4)
})

test('busy companions and registered channels block deletion before cleanup', async t => {
  const { store, service, lifecycle, calls } = await fixture(t)
  await assert.rejects(service.remove('other', { ...lifecycle, isBusy: () => true }), /正在执行/)
  await store.update(state => state.channels.push({ id: 'channel', companionId: 'other' }))
  await assert.rejects(service.remove('other', lifecycle), /微信渠道/)
  assert.equal(calls.length, 0)
})

test('workspace cleanup failure preserves identity and session links for retry', async t => {
  const { store, service, lifecycle, calls } = await fixture(t)
  await assert.rejects(service.remove('other', { ...lifecycle, detachWorkspace: async () => { throw Error('disk failure') } }), /disk failure/)
  assert.equal(store.snapshot().companions.length, 2)
  assert.equal(calls.length, 0)
  await service.remove('other', lifecycle)
  assert.equal(store.snapshot().companions.length, 1)
})

test('dedicated workspace registration cleanup does not remove files or other registrations', async t => {
  const { root } = await fixture(t)
  const cwd = join(root, 'partners', 'other')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'result.md'), 'user result')
  const rows = [{ id: 'owned', path: await realpath(cwd) }, { id: 'shared', path: root }]
  const registry = { list: () => rows, async delete(id) { rows.splice(rows.findIndex(item => item.id === id), 1); return true } }
  await removeOwnedWorkspace(registry, cwd, 'other', [])
  assert.deepEqual(rows.map(item => item.id), ['shared'])
  assert.equal(await readFile(join(cwd, 'result.md'), 'utf8'), 'user result')
})

test('shared paths and symlink directories are not removed', async t => {
  const { root } = await fixture(t)
  const cwd = join(root, 'partners', 'other')
  await mkdir(cwd, { recursive: true })
  const registry = { list: () => [{ id: 'owned', path: cwd }], async delete() { assert.fail('must not remove shared registration') } }
  await removeOwnedWorkspace(registry, cwd, 'other', [cwd])
  const linked = join(root, 'partners', 'linked')
  await symlink(cwd, linked)
  await removeOwnedWorkspace(registry, linked, 'linked', [])
  await assert.rejects(removeOwnedWorkspace(registry, root, '..', []), /标识无效/)
})

test('a missing dedicated directory can still have its stale registration removed', async t => {
  const { root } = await fixture(t)
  const cwd = join(root, 'partners', 'other')
  let removed
  await removeOwnedWorkspace({ list: () => [{ id: 'stale', path: cwd }], async delete(id) { removed = id; return true } }, cwd, 'other', [])
  assert.equal(removed, 'stale')
})

test('physical removal deletes only the owned directory, without following nested symlinks', async t => {
  const { root } = await fixture(t)
  const own = join(root, 'partners', 'other'), peer = join(root, 'partners', 'peer')
  await mkdir(join(own, 'inbound'), { recursive: true }); await mkdir(peer, { recursive: true })
  await writeFile(join(own, 'inbound', 'result.md'), 'remove this')
  await writeFile(join(peer, 'keep.md'), 'keep this')
  await symlink(peer, join(own, 'linked-peer'))
  await removeOwnedDirectory(root, 'other', [peer])
  await assert.rejects(readFile(join(own, 'inbound', 'result.md')), { code: 'ENOENT' })
  await assert.rejects(realpath(own), { code: 'ENOENT' })
  assert.equal(await readFile(join(peer, 'keep.md'), 'utf8'), 'keep this')
  await removeOwnedDirectory(root, 'other', [peer])
})

test('physical removal refuses shared child paths, traversal and symlinked roots', async t => {
  const { root } = await fixture(t)
  const own = join(root, 'partners', 'other')
  await mkdir(join(own, 'shared'), { recursive: true })
  await assert.rejects(removeOwnedDirectory(root, 'other', [join(own, 'shared')]), /共享文件/)
  for (const id of ['..', '.', '../other', '/other', 'other/../peer', '']) await assert.rejects(removeOwnedDirectory(root, id, []), /标识无效/)
  const link = join(root, 'partners', 'link')
  await symlink(own, link)
  await assert.rejects(removeOwnedDirectory(root, 'link', []), /链接/)
  const aliasRoot = join(root, 'alias-root'); await mkdir(aliasRoot)
  await symlink(join(root, 'partners'), join(aliasRoot, 'partners'))
  await assert.rejects(removeOwnedDirectory(aliasRoot, 'other', []), /链接/)
  assert.equal(await realpath(own), own)
})

test('physical cleanup succeeds before removing identity, without redundant memory recreation', async t => {
  const { root, store, service, lifecycle, calls } = await fixture(t)
  const own = join(root, 'partners', 'other'); await mkdir(own, { recursive: true })
  await writeFile(join(own, 'work.md'), 'work')
  await service.remove('other', { ...lifecycle,
    validateDirectory: async id => { assert.equal(store.isCompanionRemoving(id), true); await assertOwnedDirectory(root, id, []) },
    removeDirectory: async id => { assert.ok(store.snapshot().companions.some(item => item.id === id)); await removeOwnedDirectory(root, id, []) },
  })
  await assert.rejects(realpath(own), { code: 'ENOENT' })
  assert.equal(store.snapshot().companions.some(item => item.id === 'other'), false)
  assert.deepEqual(calls.map(([name]) => name), ['detachWorkspace', 'resetSessions'])
  assert.equal(store.isCompanionRemoving('other'), false)
})

test('physical cleanup failure keeps companion retryable and releases deletion guard', async t => {
  const { store, service, lifecycle } = await fixture(t)
  await assert.rejects(service.remove('other', { ...lifecycle, removeDirectory: async () => { throw Error('permission denied') } }), /permission denied/)
  assert.ok(store.snapshot().companions.some(item => item.id === 'other'))
  assert.equal(store.isCompanionRemoving('other'), false)
})
