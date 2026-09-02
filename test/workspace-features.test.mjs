import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PartnerStore } from '../lib/store.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { SkillService } from '../lib/skills/service.js'
import { loadSkill } from '../lib/skills/loader.js'
import { TaskBoardService, TaskConflictError } from '../lib/tasks/service.js'
import { nextOccurrence } from '../lib/scheduler/service.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-workspace-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  return { root, store, close: () => rm(root, { recursive: true, force: true }) }
}

test('migrated store exposes all bounded workspace domains', async t => {
  const item = await fixture(); t.after(item.close)
  const state = item.store.snapshot()
  assert.equal(state.schemaVersion, 11)
  for (const key of ['skills', 'skillBindings', 'skillMarketSources', 'tasks', 'taskActivities', 'delegations', 'schedules', 'executionRuns']) assert.deepEqual(state[key], [])
})

test('built-in market installs separately from companion binding', async t => {
  const item = await fixture(); t.after(item.close)
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await service.initialize()
  const market = await service.market()
  assert.ok(market.entries.some(entry => entry.id === 'technical-research'))
  const installed = await service.installMarket('builtin', 'technical-research')
  assert.equal(installed.executionContext, 'fork')
  assert.equal(service.bindings('companion-default').length, 0)
  await service.setBinding('companion-default', installed.id, true)
  assert.deepEqual(service.bindings('companion-default').map(skill => skill.id), ['technical-research'])
})

test('untrusted Skill cannot request inline execution and tampering is detected', async t => {
  const item = await fixture(); t.after(item.close)
  const repository = new SkillRepository(join(item.root, 'skills'))
  const document = `---\nname: guarded\ndescription: guarded test\ncontext: inline\n---\nDo the bounded work.`
  const skill = await repository.install({ id: 'guarded', document, source: 'market', sourceId: 'test', trusted: false })
  assert.equal(skill.executionContext, 'fork')
  await writeFile(join(skill.rootPath, 'SKILL.md'), `${await readFile(join(skill.rootPath, 'SKILL.md'), 'utf8')}\nchanged`)
  const loaded = await loadSkill({ id: skill.id, rootPath: skill.rootPath, source: skill.source, sourceId: 'test', trusted: false, installedAt: skill.installedAt, updatedAt: skill.updatedAt })
  assert.notEqual(loaded.checksum, skill.checksum)
})

test('task board rejects stale concurrent updates and records activities', async t => {
  const item = await fixture(); t.after(item.close)
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '实现看板', priority: 'high' }, { kind: 'user' })
  const moved = await board.update(task.id, { expectedRevision: 1, status: 'doing' }, { kind: 'companion', companionId: 'companion-default' })
  assert.equal(moved.revision, 2)
  await assert.rejects(() => board.update(task.id, { expectedRevision: 1, status: 'done' }, { kind: 'user' }), TaskConflictError)
  assert.equal(board.snapshot().activities.length, 2)
})

test('daily schedule calculation follows the configured time zone', () => {
  const now = Date.UTC(2026, 8, 2, 0, 0, 20)
  const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 5 }, now, 'Asia/Shanghai')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)
  assert.equal(parts, '09:05')
  assert.ok(next > now)
})
