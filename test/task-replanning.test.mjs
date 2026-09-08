import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { RequirementService } from '../lib/requirements/service.js'
import { requirementTool } from '../lib/requirements/tool.js'
import { autoRunCandidates, taskDispatchDenied } from '../lib/collaboration/task-dispatch.js'
import { TaskWorkflowError } from '../lib/tasks/workflow-error.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'

const owner = { kind: 'companion', companionId: 'companion-default' }
const executor = { kind: 'companion', companionId: 'worker' }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-replanning-'))
  const path = join(root, 'state.json'), store = await PartnerStore.open(path)
  t.after(() => rm(root, { recursive: true, force: true }))
  await store.update(s => s.companions.push({ ...s.companions[0], id: 'worker', name: '执行者' }, { ...s.companions[0], id: 'other', name: '其他人' }))
  const tasks = new TaskBoardService(store), requirements = new RequirementService(store)
  const requirement = await requirements.create({ title: '真实文件交付' }, owner)
  const task = await tasks.create({ title: '创建并验证文件', requirementId: requirement.id, assigneeCompanionId: 'worker', autoRun: true }, owner)
  await requirements.submit(requirement.id, requirements.require(requirement.id).revision, owner)
  const notices = []
  tasks.setProgressNotifier(async (task, previous) => { notices.push({ task, previous }) })
  async function review() {
    const current = tasks.require(task.id)
    await tasks.update(task.id, { expectedRevision: current.revision, status: 'doing' }, executor)
    return tasks.completeExecution(task.id, '实际文件证据或缺口', executor)
  }
  return { store, path, tasks, requirements, task, requirement, notices, review }
}

test('three rejected attempts stop auto-dispatch; only owner can explicitly resume', async t => {
  const f = await fixture(t)
  for (let n = 1; n <= 3; n++) {
    await f.review()
    const result = await f.tasks.reject(f.task.id, '缺少运行证据', owner, f.tasks.require(f.task.id).revision)
    assert.equal(result.reworkCount, n)
    assert.equal(result.status, n === 3 ? 'blocked' : 'ready')
  }
  const task = f.tasks.require(f.task.id)
  assert.equal(task.autoRun, false)
  assert.equal(task.replanRequested, true)
  assert.equal(autoRunCandidates(f.store.snapshot()).length, 0)
  assert.match(taskDispatchDenied(f.store.snapshot(), { taskId: task.id }), /重规划/)
  await assert.rejects(f.tasks.update(task.id, { expectedRevision: task.revision, autoRun: true }, executor), /仅需求负责人/)
  const resumed = await f.tasks.update(task.id, { expectedRevision: task.revision, assigneeCompanionId: 'other', autoRun: true }, owner)
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.replanRequested, false)
  assert.equal(resumed.reworkCount, 0)
  assert.equal(autoRunCandidates(f.store.snapshot()).length, 1)
})

test('executor relinquishes its running job atomically; repeat requests do not queue owner notices', async t => {
  const f = await fixture(t)
  await f.tasks.update(f.task.id, { expectedRevision: f.task.revision, status: 'doing' }, executor)
  await f.store.update(s => s.delegations.push({ id: 'old-job', kind: 'task', taskId: f.task.id, toCompanionId: 'worker', status: 'running', initiatedBy: 'user', request: '写文件', createdAt: 1 }))
  const before = f.tasks.require(f.task.id)
  const paused = await f.tasks.requestReplan(before.id, '当前没有文件工具，需要负责人改派', executor, before.revision)
  assert.equal(paused.status, 'blocked'); assert.equal(paused.autoRun, false)
  assert.equal(f.store.snapshot().delegations[0].status, 'canceled')
  assert.ok(paused.workRevision > (before.workRevision ?? 1))
  const notices = f.notices.length
  await f.tasks.requestReplan(before.id, '重复申请', executor, before.revision)
  assert.equal(f.notices.length, notices)
  assert.equal(f.tasks.require(before.id).revision, paused.revision)
  const reopened = await PartnerStore.open(f.path)
  assert.equal(reopened.snapshot().tasks[0].replanRequested, true)
  assert.equal(autoRunCandidates(reopened.snapshot()).length, 0)
})

test('replanning enforces identity and revision without changing scope or accepted work', async t => {
  const f = await fixture(t)
  await assert.rejects(f.tasks.requestReplan(f.task.id, '越权', { kind: 'companion', companionId: 'other' }, f.task.revision), /只有当前执行者/)
  await assert.rejects(f.tasks.requestReplan(f.task.id, '旧版本', executor, 0), /版本|changed|conflict/i)
  assert.equal(f.tasks.require(f.task.id).status, 'ready')
  await f.review()
  await f.tasks.accept(f.task.id, owner)
  await assert.rejects(f.tasks.requestReplan(f.task.id, '重跑', executor, f.tasks.require(f.task.id).revision), /已完成不重跑/)
})

test('explicit replan rejection pauses immediately and retains previous deliverable', async t => {
  const f = await fixture(t)
  await f.review()
  const result = await f.tasks.reject(f.task.id, '需要拆分与改派', owner, f.tasks.require(f.task.id).revision, 'replan')
  assert.equal(result.status, 'blocked'); assert.equal(result.reworkCount, 1)
  assert.ok(result.previousAttempt.resultSummary)
  assert.equal(f.requirements.require(f.requirement.id).status, 'active', 'executor does not reopen overall scope')
})

test('already blocked user-created task still hands off to the requirement owner exactly once', async t => {
  const f = await fixture(t)
  await f.store.update(s => { const task = s.tasks[0]; delete task.creatorCompanionId; task.createdBy = 'user'; task.status = 'blocked' })
  const current = f.tasks.require(f.task.id)
  await f.tasks.requestReplan(current.id, '需要负责人配置工具', executor, current.revision)
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0].previous, 'blocked')
  await f.tasks.requestReplan(current.id, '重复', executor, current.revision)
  assert.equal(f.notices.length, 1)
})

test('workflow failures return stable ids and recovery rather than suggesting blind retries', async t => {
  const f = await fixture(t)
  await assert.rejects(f.tasks.create({ title: '新拆分', requirementId: f.requirement.id }, executor), error => {
    assert.ok(error instanceof TaskWorkflowError)
    assert.equal(error.result().retryable, false)
    assert.equal(error.current.ownerCompanionId, owner.companionId)
    assert.match(error.recovery, /request_replan/)
    return true
  })
  const tool = requirementTool('worker', f.requirements, f.tasks)
  const result = JSON.parse(await tool.execute({ action: 'reopen', requirementId: f.requirement.id, expectedRevision: f.requirements.require(f.requirement.id).revision }, {}))
  assert.equal(result.code, 'REQUIREMENT_OWNER_REQUIRED')
  assert.equal(result.retryable, false)
  assert.equal(result.current.ownerCompanionId, owner.companionId)
  assert.match(result.recovery, /request_replan/)
  const listed = JSON.parse(await tool.execute({ action: 'list' }, {}))
  assert.equal(listed.requirements.length, 1)
})

test('replanning aborts active execution; late completion cannot overwrite the blocked task', async t => {
  const f = await fixture(t)
  const service = new PartnerCollaborationService(f.store, {}, f.tasks, {})
  let signal, release, calls = 0
  service.setSessionExecutor({ execute: async input => {
    calls++; signal = input.signal
    await new Promise(resolve => { release = resolve })
    return { run: { id: 'late-run' }, output: '过期的已完成报告' }
  } })
  t.after(async () => { release?.(); await service.close() })
  await service.delegate({ taskId: f.task.id, initiatedBy: 'user', to: 'worker', request: '创建文件' })
  assert.ok(signal && !signal.aborted)
  await assert.rejects(service.delegate({ taskId: f.task.id, initiatedBy: 'user', to: 'other', request: '转交' }), error => {
    assert.equal(error.code, 'TASK_ALREADY_DELEGATED')
    assert.equal(error.current.assigneeCompanionId, 'worker')
    assert.match(error.recovery, /request_replan/)
    return true
  })
  const current = f.tasks.require(f.task.id)
  await f.tasks.requestReplan(current.id, '缺文件工具', executor, current.revision)
  assert.equal(signal.aborted, true)
  release(); await service.close()
  assert.equal(f.tasks.require(current.id).status, 'blocked')
  assert.doesNotMatch(f.tasks.require(current.id).resultSummary, /过期/)
  assert.equal(calls, 1)
  await assert.rejects(service.delegate({ taskId: f.task.id, initiatedBy: 'user', to: 'other', request: '再次转交' }), error => error.code === 'TASK_REPLAN_REQUIRED')
})
