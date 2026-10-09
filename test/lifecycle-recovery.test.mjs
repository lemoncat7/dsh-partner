import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { concernManagementTool } from '../lib/concern-management-tool.js'
import { hasSustainedConcernEvidence } from '../lib/concern-domain.js'
import { BlockedTaskRecovery, recoveryPending } from '../lib/tasks/blocked-recovery.js'
import { cleanupObsoleteSchedules } from '../lib/scheduler/cleanup.js'

test('ordinary repair work is not an implicit watch, explicit ongoing observation remains possible', () => {
  for (const text of ['又报错了，赶紧修复一下', '生成还没完成，你去排查一下', '暂时生成一张图吧，请帮我做一下']) assert.equal(hasSustainedConcernEvidence(text), false, text)
  assert.equal(hasSustainedConcernEvidence('这个服务偶尔报错'), true)
  assert.equal(hasSustainedConcernEvidence('修复后继续关注，有变化通知我'), true)
})

test('concern management edits stable identity, checks revisions, resolves and deletes only owned entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-concern-tool-')); t.after(() => rm(root, { recursive: true, force: true }))
  const concerns = new PartnerConcernStore(root)
  const store = { snapshot: () => ({ sessions: [{ sessionId: 's', companionId: 'c' }], companions: [{ id: 'c', automation: { memory: { enabled: true } } }] }) }
  const tool = concernManagementTool(store, concerns), exec = { agent: { session: { id: 's' } } }
  const old = await concerns.createExplicit('c', '*', '版本更新', '留意更新')
  const edited = JSON.parse(await tool.execute({ action: 'update', concernId: old.id, expectedUpdatedAt: old.updatedAt, subject: '稳定版本更新', watchQuery: '仅正式版本' }, exec))
  assert.equal(edited.id, old.id); assert.equal(edited.watchQuery, '仅正式版本')
  await assert.rejects(tool.execute({ action: 'delete', concernId: old.id, expectedUpdatedAt: old.updatedAt }, exec), /变化/)
  await tool.execute({ action: 'resolve', concernId: edited.id, expectedUpdatedAt: edited.updatedAt }, exec)
  const [resolved] = JSON.parse(await tool.execute({ action: 'list' }, exec)); assert.equal(resolved.state, 'resolved')
  await tool.execute({ action: 'delete', concernId: resolved.id, expectedUpdatedAt: resolved.updatedAt }, exec)
  assert.deepEqual(JSON.parse(await tool.execute({ action: 'list' }, exec)), [])
  const foreign = await concerns.createExplicit('other', '*', '其他伙伴关注')
  await assert.rejects(tool.execute({ action: 'delete', concernId: foreign.id, expectedUpdatedAt: foreign.updatedAt }, exec), /没有此关注/)
})

test('blocked recovery persists creator then owner escalation across restart without endless wakes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json'), store = await PartnerStore.open(path)
  await store.update(s => {
    s.companions.push({ ...structuredClone(s.companions[0]), id: 'owner', name: 'owner' })
    s.requirements = [{ id: 'r', ownerCompanionId: 'owner' }]
    s.tasks.push({ id: 't', requirementId: 'r', title: 'test', description: '', dependencyTaskIds: [], skillIds: [], creatorCompanionId: s.companions[0].id, status: 'blocked', revision: 2, workRevision: 1 })
  })
  const owners = [], effects = { isBusy: () => false, warn: assert.fail, execute: async owner => { owners.push(owner); return '需要用户补充凭据，未重复提交' } }
  await new BlockedTaskRecovery(store, effects).tick()
  assert.equal(recoveryPending(store.snapshot(), store.snapshot().tasks[0]), true)
  const restarted = await PartnerStore.open(path), worker = new BlockedTaskRecovery(restarted, effects)
  await worker.tick(); await worker.tick()
  assert.deepEqual(owners, ['companion-default', 'owner'])
  assert.equal(restarted.snapshot().tasks[0].blockedRecovery.needsUser, true)
  assert.equal(recoveryPending(restarted.snapshot(), restarted.snapshot().tasks[0]), false)
})

test('schedule cleanup removes obsolete task timers but preserves unconsumed and undelivered results', () => {
  const state = { tasks: [{ id: 'done', status: 'done' }, { id: 'doing', status: 'doing' }], delegations: [], schedules: [
    { id: 'temporary', boardTaskId: 'done' },
    { id: 'cancelled', enabled: false, updatedAt: 1, continuation: { state: 'cancelled' } },
    { id: 'receipt', enabled: false, continuation: { state: 'completed', board: { taskId: 'doing' } } },
    { id: 'delivery', enabled: false, continuation: { state: 'completed', finalReply: { key: 'pending' } } },
    { id: 'recurring', enabled: true },
  ] }
  cleanupObsoleteSchedules(state, 100000)
  assert.deepEqual(state.schedules.map(s => s.id), ['receipt', 'delivery', 'recurring'])
})
