import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { RequirementService } from '../lib/requirements/service.js'
import { requirementTool } from '../lib/requirements/tool.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { taskWorkContext } from '../lib/tasks/context.js'
import { parseTaskExecutionOutput, publicTaskDeliverable } from '../lib/tasks/result.js'
import { reviewChecks } from '../lib/tasks/contract.js'

const actor = { kind: 'companion', companionId: 'companion-default' }
const user = { kind: 'user' }
const item = (key, extra = {}) => ({ key, title: key, assigneeCompanionId: actor.companionId, ...extra })
const plan = (extra = {}) => ({ submissionKey: 'stable-key', title: '团队交付', tasks: [item('a'), item('b', { dependsOn: ['a'] })], ...extra })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-plan-contract-'))
  const path = join(root, 'state.json'), store = await PartnerStore.open(path)
  const board = new TaskBoardService(store), requirements = new RequirementService(store)
  const skills = new SkillService(store, new SkillRepository(join(root, 'skills')))
  const collaboration = new PartnerCollaborationService(store, skills, board, {})
  const cleanup = []
  t.after(async () => { for (const release of cleanup) release(); await collaboration.close(); await rm(root, { recursive: true, force: true }) })
  return { path, store, board, requirements, collaboration, cleanup }
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)) }
  assert.fail('condition did not become true')
}

test('a plan commits once, resolves forward dependencies and keeps execution separate from scope confirmation', async t => {
  const { store, requirements } = await fixture(t)
  const observed = []
  const stop = store.subscribe(s => observed.push([s.tasks.length, s.requirements.length]), error => { throw error })
  t.after(stop)
  const description = '## 交付要求\n\n- 保留来源\n- 保留结论'
  const result = await requirements.submitPlan(plan({ description, tasks: [item('b', { dependsOn: ['a'], description }), item('a')] }), actor, 'parent-session')
  assert.deepEqual(observed, [[2, 1]])
  assert.equal(result.execution, 'submitted')
  assert.equal(result.requirement.status, 'planning')
  assert.equal(result.requirement.description, description)
  assert.equal(result.tasks[0].task.description, description)
  assert.deepEqual(result.tasks[0].task.dependencyTaskIds, [result.tasks[1].id])
  assert.ok(result.tasks.every(t => t.task.autoRun && t.task.reviewerCompanionId === actor.companionId && t.task.creatorSessionId === 'parent-session'))
  const planned = await requirements.submitPlan(plan({ submissionKey: 'second', autoRun: false, completeScope: true }), actor)
  assert.equal(planned.execution, 'planning-only')
  assert.equal(planned.requirement.status, 'active')
  assert.ok(planned.tasks.every(t => t.task.status === 'backlog' && !t.task.autoRun))
})

test('invalid plans leave no partial requirement, task, activity or receipt', async t => {
  const { store, requirements } = await fixture(t)
  await store.update(s => { s.companions.push({ ...structuredClone(s.companions[0]), id: 'private', name: '私有伙伴' }) })
  const before = store.snapshot()
  const invalid = [
    [item('a'), item('b', { dependsOn: ['missing'] })],
    [item('a', { dependsOn: ['b'] }), item('b', { dependsOn: ['a'] })],
    [item('a', { dependsOn: ['a'] })],
    [item('a'), item('a')],
    [item('a'), item('b', { assigneeCompanionId: 'private' })],
    [item('a', { reviewerCompanionId: 'private' })],
    [item('a', { skillIds: ['not-installed'] })],
    [item('a', { unexpected: true })],
    [item('a', { description: 'x'.repeat(8001) })],
    [item('a', { acceptanceCriteria: ['x'.repeat(501)] })],
  ]
  for (const tasks of invalid) {
    await assert.rejects(requirements.submitPlan(plan({ tasks }), actor))
    assert.deepEqual(store.snapshot(), before)
  }
  await store.update(s => { s.tasks = Array.from({ length: 499 }, (_, i) => ({ id: `legacy-${i}` })) })
  await assert.rejects(requirements.submitPlan(plan(), actor), /容量不足/)
  assert.equal(store.snapshot().requirements?.length ?? 0, 0)
})

test('concurrent and restarted retries are idempotent; deleted work is never resurrected', async t => {
  const { path, store, board, requirements } = await fixture(t)
  const results = await Promise.all(Array.from({ length: 4 }, () => requirements.submitPlan(plan(), actor)))
  assert.equal(results.filter(r => !r.replayed).length, 1)
  assert.equal(store.snapshot().tasks.length, 2)
  assert.ok(results.every(r => r.requirementId === results[0].requirementId))
  const reopened = new RequirementService(await PartnerStore.open(path))
  const replay = await reopened.submitPlan(plan(), actor)
  assert.equal(replay.execution, 'unchanged')
  assert.equal(replay.replayed, true)
  await assert.rejects(requirements.submitPlan(plan({ title: '不同范围' }), actor), /不同计划/)
  await board.remove(results[0].tasks[0].id)
  const removed = await requirements.submitPlan(plan(), actor)
  assert.equal(removed.execution, 'removed')
  assert.equal(removed.tasks[0].removed, true)
  assert.equal(store.snapshot().tasks.length, 1)
  await board.removeRequirement(results[0].requirementId)
  assert.equal((await requirements.submitPlan(plan(), actor)).requirement, undefined)
  assert.equal(store.snapshot().tasks.length, 0)
})

test('owner is part of user idempotency and receipt capacity does not evict prior keys', async t => {
  const { store, requirements } = await fixture(t)
  await requirements.submitPlan(plan({ ownerCompanionId: actor.companionId }), user)
  await assert.rejects(requirements.submitPlan(plan(), user), /不同计划/)
  await store.update(s => { s.planReceipts = Array.from({ length: 2000 }, (_, i) => ({ ...s.planReceipts[0], key: i ? `old-${i}` : 'stable-key' })) })
  await assert.rejects(requirements.submitPlan(plan({ submissionKey: 'new' }), actor), /安全上限/)
  assert.equal((await requirements.submitPlan(plan({ ownerCompanionId: actor.companionId }), user)).replayed, true)
})

test('continuation appends to the same planning requirement and conflicts never create another', async t => {
  const { store, requirements } = await fixture(t)
  const first = await requirements.submitPlan(plan({ completeScope: true }), actor)
  const append = { submissionKey: 'continuation', requirementId: first.requirementId, expectedRevision: first.requirement.revision, tasks: [item('c', { dependencyTaskIds: [first.tasks[1].id] })] }
  await assert.rejects(requirements.submitPlan(append, actor), /reopen/)
  const reopened = await requirements.reopen(first.requirementId, first.requirement.revision, actor)
  await assert.rejects(requirements.submitPlan(append, actor), /需求内容已更新/)
  const second = await requirements.submitPlan({ ...append, expectedRevision: reopened.revision }, actor)
  assert.equal(second.requirementId, first.requirementId)
  assert.equal(store.snapshot().requirements.length, 1)
  assert.equal(store.snapshot().tasks.length, 3)
  assert.deepEqual(second.tasks[0].task.dependencyTaskIds, [first.tasks[1].id])
})

test('dispatch failure reports a saved plan and replay never requests recreation', async t => {
  const { requirements, board, store } = await fixture(t)
  let attempts = 0
  const tool = requirementTool(actor.companionId, requirements, board, async () => { attempts++; throw new Error('offline') })
  const args = { ...plan(), action: 'submit_plan' }
  const first = JSON.parse(await tool.execute(args, {}))
  assert.match(first.warning, /已保存/)
  const second = JSON.parse(await tool.execute(args, {}))
  assert.equal(second.replayed, true)
  assert.equal(attempts, 1)
  assert.equal(store.snapshot().tasks.length, 2)
})

test('structured acceptance cannot bypass missing evidence, reviewer identity or revision checks', async t => {
  const { board, store } = await fixture(t)
  const task = await board.create({ title: '可验收交付', acceptanceCriteria: ['有实际报告', '包含核验来源'] }, actor)
  await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, actor)
  await board.completeExecution(task.id, { deliverable: '实际报告', evidence: [{ criterion: 1, reference: '/session/report.md' }] }, actor)
  await assert.rejects(board.accept(task.id, actor), /checks/)
  await assert.rejects(board.update(task.id, { expectedRevision: board.require(task.id).revision, status: 'done' }, actor), /checks/)
  const checks = [1, 2].map(criterion => ({ criterion, verdict: 'passed', evidence: '实际读取 report.md 并核对来源' }))
  await store.update(s => { s.companions.push({ ...structuredClone(s.companions[0]), id: 'other', name: '其他伙伴' }) })
  await assert.rejects(board.update(task.id, { expectedRevision: board.require(task.id).revision, status: 'done', reviewerCompanionId: 'other', checks }, { kind: 'companion', companionId: 'other' }), /不是.*验收者/)
  await assert.rejects(board.accept(task.id, actor, 1, checks), /更新|changed/i)
  await assert.rejects(board.accept(task.id, actor, undefined, [checks[0]]), /全部验收项/)
  const done = await board.accept(task.id, actor, undefined, checks)
  assert.equal(done.status, 'done'); assert.deepEqual(done.reviewChecks, checks)
  await assert.rejects(board.create({ title: '跳过验收', status: 'done', acceptanceCriteria: ['报告'] }, actor), /不能直接创建/)
})

test('reject carries specific gaps into rework and scope changes invalidate old evidence', async t => {
  const { board, store } = await fixture(t)
  const task = await board.create({ title: '修正报告', status: 'doing', acceptanceCriteria: ['报告有来源'] }, actor)
  await board.completeExecution(task.id, '旧报告', actor)
  await assert.rejects(board.reject(task.id, '补来源', actor), /checks/)
  const gap = [{ criterion: 1, verdict: 'unverified', reason: '缺少原文链接' }]
  const rejected = await board.reject(task.id, '补齐引用', actor, undefined, 'rework', gap)
  assert.deepEqual(rejected.previousAttempt.reviewChecks, gap)
  assert.match(taskWorkContext(store.snapshot(), rejected), /缺少原文链接/)
  await board.update(task.id, { expectedRevision: rejected.revision, status: 'doing' }, actor)
  await board.completeExecution(task.id, { deliverable: '新报告', evidence: [{ criterion: 1, reference: 'https://example.org/source' }] }, actor)
  const current = board.require(task.id)
  const updated = await board.update(task.id, { expectedRevision: current.revision, acceptanceCriteria: ['报告包含新的对照表'] }, user)
  assert.equal(updated.status, 'ready'); assert.equal(updated.evidence, undefined)
  assert.equal(updated.reviewChecks, undefined)
  assert.ok(updated.workRevision > (current.workRevision ?? 1))
})

test('malformed evidence keeps the deliverable for review instead of redoing external actions', async t => {
  const { board } = await fixture(t)
  for (const value of ['not-json', '[{"criterion":99,"reference":"/report.md"}]']) {
    const raw = `<partner-deliverable>已保存报告</partner-deliverable><partner-evidence>${value}</partner-evidence>`
    assert.equal(publicTaskDeliverable(raw), '已保存报告')
    const task = await board.create({ title: '报告', status: 'doing', acceptanceCriteria: ['报告可读'] }, actor)
    const result = await board.completeExecution(task.id, parseTaskExecutionOutput(raw), actor)
    assert.equal(result.status, 'review'); assert.equal(result.resultSummary, '已保存报告')
    assert.match(result.reviewHandoff, /交付已保留/); assert.deepEqual(result.evidence, [])
    await assert.rejects(board.accept(task.id, actor), /checks/)
  }
  assert.throws(() => reviewChecks([{ criterion: 1, verdict: 'passed' }], ['报告'], true), /核验证据/)
  assert.deepEqual(reviewChecks(undefined, [], true), [])
  assert.deepEqual(reviewChecks(undefined, [], false), [])
})

test('resource conflicts wait without starving independent work and deleting a running task retains its live lock', async t => {
  const { board, requirements, collaboration, store, cleanup } = await fixture(t)
  const calls = [], releases = new Map()
  collaboration.setSessionExecutor({ execute: async input => {
    calls.push(input)
    return new Promise(resolve => releases.set(input.sourceId, () => resolve({ run: { id: input.sourceId }, output: '已交付' })))
  } })
  cleanup.push(() => { for (const release of releases.values()) release() })
  const result = await requirements.submitPlan(plan({ tasks: [item('a', { resourceKeys: ['repo:shared'] }), item('b', { resourceKeys: ['repo:shared'] }), item('c'), item('d')] }), actor)
  const [a, b, c, d] = result.tasks
  await collaboration.dispatchReadyTasks()
  await waitFor(() => calls.length === 3)
  assert.equal(board.require(b.id).status, 'ready')
  assert.ok([a, c, d].every(t => board.require(t.id).status === 'doing'))
  assert.equal(board.snapshot().tasks.find(t => t.id === b.id).scheduling.code, 'resource_busy')
  await assert.rejects(board.update(b.id, { expectedRevision: board.require(b.id).revision, status: 'doing' }, user), /共享资源/)
  await board.remove(a.id)
  await collaboration.dispatchReadyTasks(); assert.equal(calls.length, 3)
  assert.equal(board.snapshot().tasks.find(t => t.id === b.id).scheduling.code, 'resource_busy')
  assert.ok(calls[0].signal.aborted)
  releases.get(calls[0].sourceId)()
  await waitFor(() => !collaboration.active.has(calls[0].sourceId))
  await collaboration.dispatchReadyTasks(); await waitFor(() => calls.length === 4)
  assert.equal(board.require(b.id).status, 'doing')
  for (const release of releases.values()) release()
  await waitFor(() => store.snapshot().delegations.every(d => d.status !== 'running'))
})

test('an atomic plan progresses through dependency acceptance without duplicate execution', async t => {
  const { board, requirements, collaboration } = await fixture(t)
  const calls = []
  collaboration.setSessionExecutor({ execute: async input => {
    calls.push(input)
    return { run: { id: input.sourceId }, output: '<partner-deliverable>实际产出</partner-deliverable><partner-evidence>[{"criterion":1,"reference":"/session/result.md"}]</partner-evidence>' }
  } })
  const input = plan({ tasks: [item('a', { acceptanceCriteria: ['产出可读取'] }), item('b', { dependsOn: ['a'], acceptanceCriteria: ['汇总前置产出'] })] })
  const result = await requirements.submitPlan(input, actor)
  const [a, b] = result.tasks
  await collaboration.dispatchReadyTasks()
  await waitFor(() => board.require(a.id).status === 'review')
  await collaboration.dispatchReadyTasks()
  assert.equal(calls.length, 1)
  assert.equal(board.snapshot().tasks.find(t => t.id === b.id).scheduling.code, 'dependencies')
  await requirements.submitPlan(input, actor)
  const checks = [{ criterion: 1, verdict: 'passed', evidence: '已读取 /session/result.md 的产出' }]
  await board.accept(a.id, actor, undefined, checks)
  await collaboration.dispatchReadyTasks()
  await waitFor(() => board.require(b.id).status === 'review')
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /已验收前置任务的公开产出/)
  await board.accept(b.id, actor, undefined, checks)
  await collaboration.dispatchReadyTasks()
  assert.equal(calls.length, 2)
})
