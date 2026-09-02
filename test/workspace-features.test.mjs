import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { PartnerStore } from '../lib/store.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { SkillService } from '../lib/skills/service.js'
import { loadSkill } from '../lib/skills/loader.js'
import { TaskBoardService, TaskConflictError } from '../lib/tasks/service.js'
import { nextOccurrence } from '../lib/scheduler/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { dispatchPartnerWorkspaceApi } from '../lib/api/features/workspace-api.js'
import { registerPartnerApi } from '../lib/api.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-workspace-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  return { root, store, close: () => rm(root, { recursive: true, force: true }) }
}

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  return Object.assign(req, { method, url, headers: { host: 'localhost', origin: 'http://localhost', 'x-dsh-partner-request': '1' } })
}

function response() {
  return { statusCode: 0, body: '', setHeader() {}, end(value) { this.body = value?.toString() ?? '' } }
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

test('cross-partner delegation requires the explicit collaboration capability', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.companions.push({
    ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴', createdAt: 2, updatedAt: 2,
  }))
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '权限边界测试' }, { kind: 'user' })
  const service = new PartnerCollaborationService(item.store, skills, board, { execute: async () => { throw new Error('executor must not run') } })
  await assert.rejects(() => service.delegate({
    taskId: task.id, fromCompanionId: 'companion-default', to: 'companion-reviewer', request: '执行任务',
  }), /没有伙伴协作权限/)
  assert.equal(item.store.snapshot().delegations.length, 0)
})

test('partner collaboration tools are composed only inside an authorized companion scope', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const collaboration = new PartnerCollaborationService(item.store, skills, board, {})
  const composition = new PartnerAgentComposition(item.store, skills, board, collaboration, {}, {})
  const compose = companion => {
    const names = []
    composition.compose({ tools: { register: tool => names.push(tool.name) }, systemPrompt: { section() {} } }, companion)
    return names
  }
  const companion = item.store.snapshot().companions[0]
  assert.ok(compose(companion).includes('partner_task_board'))
  assert.ok(!compose(companion).includes('partner_collaborate'))
  assert.ok(compose(companion).includes('partner_skill'))
  assert.ok(compose({ ...companion, capabilities: [...companion.capabilities, 'collaboration'] }).includes('partner_collaborate'))
})

test('Skill binding reload observes the committed binding state', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await skills.initialize()
  const installed = await skills.installMarket('builtin', 'technical-research')
  let observed = false
  const handled = await dispatchPartnerWorkspaceApi(
    request('PUT', '/', { enabled: true }), response(), ['companions', 'companion-default', 'skills', installed.id], new URL('http://localhost/'),
    {
      store: item.store, skills, tasks: {}, collaboration: {}, scheduler: {},
      agents: { async reloadCompanion() { observed = skills.bindings('companion-default').some(skill => skill.id === installed.id) } },
    },
  )
  assert.equal(handled, true)
  assert.equal(observed, true)
})

test('companion capability reload observes committed permissions', async t => {
  const item = await fixture(); t.after(item.close)
  let handler
  let observed = false
  const runtime = {
    store: item.store,
    agents: { async reloadCompanion(id) { observed = item.store.snapshot().companions.find(companion => companion.id === id)?.capabilities.includes('collaboration') === true } },
  }
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/partner-local/v1', runtime)
  const companion = item.store.snapshot().companions[0]
  const res = response()
  await handler(request('PUT', '/partner-local/v1/companions/companion-default', { companion: { ...companion, capabilities: [...companion.capabilities, 'collaboration'] } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(observed, true)
})

test('daily schedule calculation follows the configured time zone', () => {
  const now = Date.UTC(2026, 8, 2, 0, 0, 20)
  const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 5 }, now, 'Asia/Shanghai')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)
  assert.equal(parts, '09:05')
  assert.ok(next > now)
})
