import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { PartnerStore } from '../lib/store.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { SkillService } from '../lib/skills/service.js'
import { loadSkill } from '../lib/skills/loader.js'
import { TaskBoardService, TaskConflictError } from '../lib/tasks/service.js'
import { nextOccurrence } from '../lib/scheduler/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { dispatchPartnerWorkspaceApi } from '../lib/api/features/workspace-api.js'
import { parseMarketResponse } from '../lib/skills/markets/adapters.js'
import { builtinMarketSources } from '../lib/skills/markets/builtin.js'
import { requestRemoteText } from '../lib/skills/network.js'

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
  assert.equal(state.schemaVersion, 13)
  for (const key of ['skills', 'skillBindings', 'tasks', 'taskActivities', 'delegations', 'companionAccessGrants', 'schedules', 'executionRuns']) assert.deepEqual(state[key], [])
  assert.deepEqual(state.skillMarketSources.map(source => source.name), ['ClawHub', 'LoopHub', 'SkillHub'])
  assert.deepEqual(state.skillMarketNetwork, {})
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

test('nomifun-compatible market adapters normalize ClawHub, LoopHub and SkillHub rankings', () => {
  const [clawhub, loophub, skillhub] = builtinMarketSources(1)
  const claw = parseMarketResponse({ value: { page: [{ ownerHandle: 'alice', skill: { slug: 'web-audit', displayName: 'Web Audit', summary: 'Audit sites', topics: ['web'], isSuspicious: false }, latestVersion: { version: '1.2.0' } }] } }, clawhub)
  const loop = parseMarketResponse({ data: { items: [{ author: 'bob', name: 'Planner', brief: 'Plan work', category: 'productivity', security_level: 'A', download_url: 'https://dl.cocoloop.cn/bss/skills/bob-planner-2.0.1.zip' }] } }, loophub)
  const hub = parseMarketResponse({ data: { skills: [{ name: 'Research', slug: 'research', description_zh: '资料研究', version: '3.0.0', namespace: { canonicalName: '@carol/research', handle: 'carol' }, subCategories: [{ name: '检索' }] }] } }, skillhub)
  assert.deepEqual([claw.length, loop.length, hub.length], [1, 1, 1])
  assert.equal(claw[0].skillUrl, 'https://clawhub.ai/api/v1/download?slug=web-audit&version=1.2.0')
  assert.equal(loop[0].version, '2.0.1')
  assert.equal(hub[0].skillUrl, 'https://api.skillhub.cn/api/v1/download?slug=research')
  assert.ok([claw[0], loop[0], hub[0]].every(entry => entry.installKind === 'zip'))
})

test('Skill market proxy settings are local and the bounded client routes HTTP requests through them', async t => {
  const item = await fixture(); t.after(item.close)
  let requestedUrl = ''
  const proxy = createServer((req, res) => { requestedUrl = req.url ?? ''; res.setHeader('content-type', 'text/plain'); res.end('proxied') })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  const address = proxy.address()
  const proxyUrl = `http://127.0.0.1:${address.port}`
  const text = await requestRemoteText({ url: 'http://market.invalid/index.json', proxyUrl, maxBytes: 1024, timeoutMs: 2_000 })
  assert.equal(text, 'proxied')
  assert.equal(requestedUrl, 'http://market.invalid/index.json')
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  assert.deepEqual(await service.setNetworkSettings({ proxyUrl }), { proxyUrl: `${proxyUrl}/` })
  assert.deepEqual(service.networkSettings(), { proxyUrl: `${proxyUrl}/` })
  await assert.rejects(() => service.setNetworkSettings({ proxyUrl: 'socks5://127.0.0.1:1080' }), /仅支持 http/)
})

test('locally authored Skill documents install through the same bounded repository', async t => {
  const item = await fixture(); t.after(item.close)
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await service.initialize()
  const installed = await service.installLocal(`---\nname: local-review\ndisplay-name: 本地审阅\ndescription: 审阅本地变更\nversion: 1.0.0\ncontext: fork\nallowed-tools: [read, grep]\n---\n# 本地审阅\n\n检查变更并给出证据。`, 'local-review')
  assert.equal(installed.source, 'local')
  assert.equal(installed.displayName, '本地审阅')
  assert.deepEqual(installed.allowedTools, ['read', 'grep'])
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

test('cross-partner delegation uses directed grants while user delegation bypasses partner grants', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.companions.push({
    ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴', createdAt: 2, updatedAt: 2,
  }))
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '权限边界测试' }, { kind: 'user' })
  const service = new PartnerCollaborationService(item.store, skills, board, { execute: async () => ({ run: { id: 'run-1' }, output: '完成' }) })
  await assert.rejects(() => service.delegate({
    taskId: task.id, initiatedBy: 'companion', fromCompanionId: 'companion-default', to: 'companion-reviewer', request: '执行任务',
  }), /未获授权/)
  assert.equal(item.store.snapshot().delegations.length, 0)
  await service.replaceAccessTargets('companion-default', ['companion-reviewer'])
  assert.equal(service.canAccess('companion-default', 'companion-reviewer'), true)
  assert.equal(service.canAccess('companion-reviewer', 'companion-default'), false)
  assert.deepEqual(service.directoryFor('companion-default').map(entry => entry.id), ['companion-reviewer'])
  const delegated = await service.delegate({ taskId: task.id, initiatedBy: 'companion', fromCompanionId: 'companion-default', to: 'companion-reviewer', request: '执行任务' })
  assert.equal(delegated.initiatedBy, 'companion')

  const userTask = await board.create({ title: '用户直接委派' }, { kind: 'user' })
  const userDelegation = await service.delegate({ taskId: userTask.id, initiatedBy: 'user', to: 'companion-default', request: '用户执行' })
  assert.equal(userDelegation.initiatedBy, 'user')
  assert.equal(userDelegation.fromCompanionId, undefined)
})

test('partner collaboration tools are always available but their directory remains grant-scoped', async t => {
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
  assert.ok(compose(companion).includes('partner_collaborate'))
  assert.ok(compose(companion).includes('partner_skill'))
  assert.deepEqual(collaboration.directoryFor(companion.id), [])
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

test('companion access API commits directed grants before reloading the source companion', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.companions.push({ ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴' }))
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const collaboration = new PartnerCollaborationService(item.store, skills, new TaskBoardService(item.store), {})
  let observed = false
  const res = response()
  const handled = await dispatchPartnerWorkspaceApi(request('PUT', '/', { targetIds: ['companion-reviewer'] }), res, ['companions', 'companion-default', 'access'], new URL('http://localhost/'), {
    store: item.store, skills, tasks: {}, collaboration, scheduler: {},
    agents: { async reloadCompanion(id) { observed = id === 'companion-default' && collaboration.canAccess(id, 'companion-reviewer') } },
  })
  assert.equal(handled, true)
  assert.equal(observed, true)
})

test('daily schedule calculation follows the configured time zone', () => {
  const now = Date.UTC(2026, 8, 2, 0, 0, 20)
  const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 5 }, now, 'Asia/Shanghai')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)
  assert.equal(parts, '09:05')
  assert.ok(next > now)
})
