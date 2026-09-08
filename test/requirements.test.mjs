import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { RequirementService } from '../lib/requirements/service.js'
import { RequirementWorker, requirementSummaryPrompt } from '../lib/requirements/worker.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { taskWorkContext } from '../lib/tasks/context.js'
import { requirementIsIdle, requirementProgressKey } from '../lib/requirements/progress.js'
import { consolidateCompletedRequirements } from '../lib/requirements/consolidation.js'
import { requirementTool } from '../lib/requirements/tool.js'

const actor = { kind: 'companion', companionId: 'companion-default' }
test('large requirement summary includes every child within a bounded prompt', () => {
  const tasks = Array.from({ length: 500 }, (_, i) => ({ title: `任务-${i} ` + '长标题'.repeat(60), resultSummary: '交付内容'.repeat(3000) }))
  const prompt = requirementSummaryPrompt({ id: 'req', title: '需求', description: '背景'.repeat(4000) }, tasks)
  assert.ok(prompt.length <= 60_000)
  assert.match(prompt, /## 500\. 任务-499/)
  assert.equal((prompt.match(/^## /gm) ?? []).length, 500)
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-requirements-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = new TaskBoardService(store), service = new RequirementService(store)
  const requirement = await service.create({ title: '交付一个完整需求' }, actor, 'origin-channel-session')
  const add = title => tasks.create({ title, requirementId: requirement.id }, actor)
  const accept = async task => {
    const doing = await tasks.update(task.id, { expectedRevision: tasks.require(task.id).revision, status: 'doing' }, actor)
    await tasks.completeExecution(doing.id, '实际交付结果', actor)
    return tasks.accept(task.id, actor)
  }
  const current = () => service.require(requirement.id)
  return { root, store, tasks, service, requirement, add, accept, current }
}

test('requirement submission seals scope; only all accepted children allow archiving', async t => {
  const { service, requirement, add, accept, current } = await fixture(t)
  await assert.rejects(service.submit(requirement.id, current().revision, actor), /子任务/)
  const first = await add('设计'), second = await add('实现')
  await assert.rejects(service.finish(requirement.id, current().revision, '过早汇总', actor), /不能完成归档/)
  await service.submit(requirement.id, current().revision, actor)
  await assert.rejects(add('临时扩大范围'), /规划状态/)
  await accept(first)
  await assert.rejects(service.finish(requirement.id, current().revision, '还没完', actor), /不能完成归档/)
  await accept(second)
  const archived = await service.finish(requirement.id, current().revision, '完整成果', actor)
  assert.equal(archived.status, 'done'); assert.ok(archived.archivedAt)
  assert.equal(archived.results.length, 2); assert.equal(archived.creatorSessionId, 'origin-channel-session')
})

test('scope revisions and owner permission reject stale and unauthorized completion', async t => {
  const { service, requirement, add, current } = await fixture(t)
  const stale = current().revision
  await add('工作')
  await service.update(requirement.id, current().revision, { description: '真正的范围变化' }, actor)
  await assert.rejects(service.submit(requirement.id, stale, actor), /内容已更新/)
  await assert.rejects(service.submit(requirement.id, current().revision, { kind: 'companion', companionId: 'other' }), /只有需求负责人/)
  await assert.rejects(service.assignOwner(requirement.id, current().revision, 'missing'), /不存在/)
  await service.assignOwner(requirement.id, current().revision, undefined)
  assert.equal(current().ownerCompanionId, undefined)
})

test('creating children and background progress do not stale the planning revision', async t => {
  const { tasks, service, requirement, add, current } = await fixture(t)
  const children = await Promise.all(['一', '二', '三', '四'].map(add))
  await tasks.comment(children[0].id, '执行进度', actor)
  await tasks.update(children[0].id, { expectedRevision: tasks.require(children[0].id).revision, status: 'doing' }, actor)
  assert.ok(current().revision > requirement.revision)
  assert.equal(current().controlRevision, requirement.revision)
  const submitted = await service.submit(requirement.id, requirement.revision, actor)
  assert.equal(submitted.status, 'active')
  await tasks.completeExecution(children[0].id, '结果', actor)
  const before = current().revision
  assert.equal((await service.submit(requirement.id, submitted.revision, actor)).revision, before, 'repeat submit is a no-op')
  const reopened = await service.reopen(requirement.id, submitted.revision, actor)
  assert.equal(reopened.status, 'planning')
  await tasks.comment(children[0].id, '新进度', actor)
  const updated = await service.update(requirement.id, reopened.revision, { description: '新要求' }, actor)
  assert.equal(updated.description, '新要求')
  assert.equal(tasks.require(children[0].id).status, 'ready', 'real edits still invalidate old work')
})

test('child specification edits and deletion require a fresh scope read, but not child progress', async t => {
  const { tasks, service, requirement, add, current } = await fixture(t)
  const task = await add('工作'), old = current().revision
  await tasks.update(task.id, { expectedRevision: task.revision, title: '用户修改子任务目标' }, actor)
  await assert.rejects(service.submit(requirement.id, old, actor), e => e.status === 409 && e.current.id === requirement.id)
  const beforeRemoval = current().revision
  await tasks.remove(task.id)
  await add('替代任务')
  await assert.rejects(service.submit(requirement.id, beforeRemoval, actor), /内容已更新/)
  await service.submit(requirement.id, current().revision, actor)
})

test('only one concurrent content edit wins and conflict returns current content', async t => {
  const { service, requirement, current } = await fixture(t)
  const outcomes = await Promise.allSettled([
    service.update(requirement.id, requirement.revision, { description: '方案甲' }, actor),
    service.update(requirement.id, requirement.revision, { description: '方案乙' }, actor),
  ])
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1)
  const error = outcomes.find(o => o.status === 'rejected').reason
  assert.equal(error.code, 'REQUIREMENT_REVISION_CONFLICT')
  assert.equal(error.current.description, current().description)
  assert.match(error.recovery, /不要重复创建/)
  await assert.rejects(service.update(requirement.id, current().revision + 1, { title: '未来版本' }, actor), e => e.status === 409)
  await assert.rejects(service.reopen(requirement.id, 0, actor), e => e.status === 409)
})

test('requirement tools return actionable conflicts; list never needs a revision', async t => {
  const { tasks, service, requirement, add, current } = await fixture(t)
  const tool = requirementTool(actor.companionId, service, tasks), exec = {}
  await add('工作')
  await service.update(requirement.id, current().revision, { description: '最新范围' }, actor)
  const response = JSON.parse(await tool.execute({ action: 'submit', requirementId: requirement.id, expectedRevision: requirement.revision }, exec))
  assert.equal(response.ok, false)
  assert.equal(response.code, 'REQUIREMENT_REVISION_CONFLICT')
  assert.equal(response.current.description, '最新范围')
  const listed = JSON.parse(await tool.execute({ action: 'list', expectedRevision: -1 }, exec))
  assert.equal(listed.requirements[0].revision, response.current.revision)
  const result = JSON.parse(await tool.execute({ action: 'submit', requirementId: requirement.id, expectedRevision: response.current.revision }, exec))
  assert.equal(result.status, 'active')
})

test('changing the owner invalidates an older user revision and preserves companion authorization', async t => {
  const { service, requirement, add, current } = await fixture(t)
  await add('工作')
  const old = current().revision
  await service.assignOwner(requirement.id, old, undefined)
  await assert.rejects(service.submit(requirement.id, old, { kind: 'user' }), e => e.status === 409)
  await assert.rejects(service.submit(requirement.id, current().revision, actor), e => e.status === 403)
  assert.equal((await service.submit(requirement.id, current().revision, { kind: 'user' })).status, 'active')
})

test('legacy version boundary survives progress and a store restart without trusting unknown old revisions', async t => {
  const { root, store, tasks, service, requirement, add, current } = await fixture(t)
  const task = await add('旧版本任务')
  await store.update(state => { delete state.requirements[0].controlRevision })
  const known = current().revision
  await tasks.comment(task.id, '升级后的进度', actor)
  const restored = await PartnerStore.open(join(root, 'state.json'))
  const next = new RequirementService(restored)
  assert.equal(next.require(requirement.id).controlRevision, known)
  await assert.rejects(next.submit(requirement.id, known - 1, actor), /内容已更新/)
  assert.equal((await next.submit(requirement.id, known, actor)).status, 'active')
})

test('finish still requires the exact reviewed snapshot after a child comment', async t => {
  const { tasks, service, requirement, add, accept, current } = await fixture(t)
  const task = await add('工作'); await accept(task)
  const reviewed = current().revision
  await tasks.comment(task.id, '补充结果证据', actor)
  await assert.rejects(service.finish(requirement.id, reviewed, '旧总结', actor), e => {
    assert.match(e.recovery, /不要只替换版本号/)
    return e.status === 409
  })
  assert.notEqual(current().status, 'done')
  assert.equal((await service.finish(requirement.id, current().revision, '基于新证据汇总', actor)).status, 'done')
})

test('progress during automatic summary still aborts and cannot archive stale output', async t => {
  const { store, tasks, service, requirement, add, accept, current } = await fixture(t)
  const task = await add('工作'); await accept(task)
  await service.submit(requirement.id, current().revision, actor)
  let release, began, signal
  const started = new Promise(resolve => { began = resolve })
  const worker = new RequirementWorker(store, service, {
    summarize: async (_r, _t, s) => { signal = s; began(); return new Promise(resolve => { release = resolve }) },
    deliver: async () => assert.fail('must not deliver stale summary'), warn() {},
  })
  const pending = worker.tick(); await started
  await tasks.comment(task.id, '新结果信息', actor)
  assert.ok(signal.aborted)
  release('旧总结'); await pending; await worker.close()
  assert.equal(current().status, 'active'); assert.equal(current().summary, undefined)
})

test('removal is idempotent, pauses dependents, removes queue records and reopens requirement scope', async t => {
  const { store, tasks, service, requirement, add, current } = await fixture(t)
  const first = await add('前置'), second = await tasks.create({ title: '后续', requirementId: requirement.id, dependencyTaskIds: [first.id], assigneeCompanionId: actor.companionId, autoRun: true }, actor)
  await service.submit(requirement.id, current().revision, actor)
  await store.update(s => s.delegations.push({ id: 'pending', taskId: second.id, status: 'queued' }))
  let canceled = []
  tasks.setRemovalNotifier(ids => canceled.push(...ids))
  await tasks.remove(first.id); await tasks.remove(first.id)
  assert.equal(store.snapshot().delegations.length, 0)
  assert.equal(tasks.require(second.id).status, 'blocked'); assert.equal(tasks.require(second.id).autoRun, false)
  assert.deepEqual(tasks.require(second.id).dependencyTaskIds, [])
  assert.equal(current().status, 'planning'); assert.ok(canceled.includes(second.id))
  await assert.rejects(tasks.update(first.id, { expectedRevision: 1 }, actor), error => error.status === 404)
  await tasks.removeRequirement(requirement.id); await tasks.removeRequirement(requirement.id)
  assert.equal(service.list().length, 0); assert.equal(tasks.snapshot().tasks.length, 0)
})

test('archived deliverables survive child removal and cannot be silently rewritten', async t => {
  const { tasks, service, requirement, add, accept, current } = await fixture(t)
  const task = await add('交付物'); await accept(task)
  await service.submit(requirement.id, current().revision, actor)
  await service.finish(requirement.id, current().revision, '结论', actor)
  await assert.rejects(tasks.update(task.id, { expectedRevision: tasks.require(task.id).revision, title: '改历史' }, actor), /不能修改/)
  await tasks.remove(task.id)
  assert.equal(current().results[0].resultSummary, '实际交付结果'); assert.equal(current().status, 'done')
})

test('summary waits for submitted scope, delivers once, and retries notification after restart without resummarizing', async t => {
  const { root, store, service, requirement, add, accept, current } = await fixture(t)
  const task = await add('任务'); await accept(task)
  let summaries = 0, deliveries = 0
  const worker = new RequirementWorker(store, service, { summarize: async () => { summaries++; return '汇总' }, deliver: async () => { deliveries++; throw new Error('网络断开') }, warn() {} })
  await worker.tick(); assert.equal(summaries, 0)
  await service.submit(requirement.id, current().revision, actor)
  await worker.tick(); await worker.close()
  assert.equal(summaries, 1); assert.equal(deliveries, 1); assert.equal(current().status, 'done'); assert.match(current().lastError, /网络断开/)
  const restored = await PartnerStore.open(join(root, 'state.json')), restoredService = new RequirementService(restored)
  await restoredService.retry(requirement.id)
  const resumed = new RequirementWorker(restored, restoredService, { summarize: async () => assert.fail('must reuse persisted summary'), deliver: async () => { deliveries++ }, warn() {} })
  await resumed.tick(); await resumed.tick(); await resumed.close()
  assert.equal(deliveries, 2); assert.ok(restoredService.require(requirement.id).notifiedAt)
})

test('deleting a requirement aborts in-flight summary and ignores its late result', async t => {
  const { store, tasks, service, requirement, add, accept, current } = await fixture(t)
  await accept(await add('任务')); await service.submit(requirement.id, current().revision, actor)
  let release, started, signal
  const began = new Promise(resolve => { started = resolve })
  const worker = new RequirementWorker(store, service, { summarize: async (_r, _t, s) => { signal = s; started(); return new Promise(resolve => { release = resolve }) }, deliver: async () => assert.fail('deleted requirement must not deliver'), warn() {} })
  const run = worker.tick(); await began
  await tasks.removeRequirement(requirement.id); assert.equal(signal.aborted, true)
  release('迟到结论'); await run; await worker.close(); assert.equal(service.list().length, 0)
})

test('deleting a running task aborts its execution; late success never resurrects records', async t => {
  const { store, tasks, add } = await fixture(t)
  const task = await add('被取消的执行')
  const collaboration = new PartnerCollaborationService(store, {}, tasks, {})
  let release, signal, started
  const began = new Promise(resolve => { started = resolve })
  collaboration.setSessionExecutor({ execute: async input => { signal = input.signal; started(); return new Promise(resolve => { release = resolve }) } })
  await collaboration.delegate({ taskId: task.id, initiatedBy: 'user', to: actor.companionId, request: '执行' })
  await began; await tasks.remove(task.id)
  assert.equal(signal.aborted, true)
  release({ run: { id: 'late' }, output: '迟到结果' }); await collaboration.close()
  assert.equal(store.snapshot().tasks.length, 0); assert.equal(store.snapshot().delegations.length, 0)
  assert.equal(store.snapshot().taskActivities.length, 0)
})

test('rework preserves rejected output and injects new requirements, comments and rejection after restart', async t => {
  const { root, store, tasks, service, requirement, add, current } = await fixture(t)
  const task = await add('产品设计')
  await tasks.update(task.id, { expectedRevision: task.revision, status: 'doing' }, actor)
  await tasks.completeExecution(task.id, { deliverable: '旧版只有文字说明', reviewHandoff: '缺少三态原型' }, actor)
  await tasks.comment(task.id, '新增收起、小人条、展开三态原型', actor)
  await tasks.reject(task.id, '必须补齐三态原型与点击热区', actor, tasks.require(task.id).revision)
  assert.equal(tasks.require(task.id).previousAttempt.resultSummary, '旧版只有文字说明')
  await service.update(requirement.id, current().revision, { description: '最新范围：产品设计加低保真原型，不做开发' }, actor)
  const restored = await PartnerStore.open(join(root, 'state.json'))
  const restoredTasks = new TaskBoardService(restored)
  const collaboration = new PartnerCollaborationService(restored, {}, restoredTasks, {})
  let prompt, release, started
  const began = new Promise(resolve => { started = resolve })
  collaboration.setSessionExecutor({ execute: async input => { prompt = input.prompt; started(); return new Promise(resolve => { release = resolve }) } })
  await collaboration.delegate({ taskId: task.id, initiatedBy: 'user', to: actor.companionId, request: '旧委派：只写说明' })
  await began
  for (const fragment of ['最新范围：产品设计加低保真原型', '新增收起、小人条、展开三态原型', '必须补齐三态原型与点击热区', '旧版只有文字说明', '缺少三态原型']) assert.ok(prompt.includes(fragment), fragment)
  release({ run: { id: 'new' }, output: '真正补齐原型' }); await collaboration.close()
  assert.equal(restoredTasks.require(task.id).resultSummary, '真正补齐原型')
})

test('legacy rejection activities are used even without new persisted fields', async t => {
  const { store, add } = await fixture(t), task = await add('旧任务')
  await store.update(s => s.taskActivities.push({ taskId: task.id, kind: 'reopened', message: '验收打回：缺少原型', at: Date.now() }))
  assert.match(taskWorkContext(store.snapshot(), task), /缺少原型/)
})

test('scope update aborts active work and late output cannot overwrite new task revision', async t => {
  const { store, tasks, service, requirement, add, current } = await fixture(t)
  const task = await add('修改中的任务'), collaboration = new PartnerCollaborationService(store, {}, tasks, {})
  let signal, release, started
  const began = new Promise(resolve => { started = resolve })
  collaboration.setSessionExecutor({ execute: async input => { signal = input.signal; started(); return new Promise(resolve => { release = resolve }) } })
  await collaboration.delegate({ taskId: task.id, initiatedBy: 'user', to: actor.companionId, request: '旧需求' })
  await began
  await service.update(requirement.id, current().revision, { description: '新需求' }, actor)
  assert.ok(signal.aborted)
  release({ run: { id: 'late' }, output: '过时结果' }); await collaboration.close()
  assert.equal(tasks.require(task.id).status, 'ready'); assert.equal(tasks.require(task.id).resultSummary, undefined)
  assert.equal(store.snapshot().delegations[0].status, 'canceled')
  await tasks.update(task.id, { expectedRevision: tasks.require(task.id).revision, status: 'doing' }, actor)
  await assert.rejects(tasks.completeExecution(task.id, '过时版本结果', actor, 1), e => e.status === 409)
})

test('review decisions cannot apply to a task changed during review', async t => {
  const { tasks, add } = await fixture(t), task = await add('核验')
  await tasks.update(task.id, { expectedRevision: task.revision, status: 'doing' }, actor)
  const review = await tasks.completeExecution(task.id, '交付', actor)
  await tasks.comment(task.id, '请核对刚补充的原型要求', actor)
  for (const operation of [
    () => tasks.accept(task.id, actor, review.revision),
    () => tasks.reject(task.id, '旧意见', actor, review.revision),
    () => tasks.recordReview(task.id, '旧意见', actor, review.revision),
  ]) await assert.rejects(operation(), e => e.status === 409)
  assert.equal(tasks.require(task.id).status, 'review')
  await tasks.accept(task.id, actor, tasks.require(task.id).revision)
})

test('stage notifications require ONLY done/blocked tasks; waiting and review are internal', async t => {
  const { store, tasks, requirement, add, accept, current } = await fixture(t)
  const first = await add('已完成'), second = await add('候选状态'); await accept(first)
  for (const status of ['backlog', 'ready', 'doing', 'review', 'blocked', 'done']) {
    await store.update(s => { s.tasks.find(t => t.id === second.id).status = status })
    assert.equal(requirementIsIdle(store.snapshot(), current()), ['blocked', 'done'].includes(status), status)
  }
  await store.update(s => s.delegations.push({ taskId: second.id, status: 'queued' }))
  assert.equal(requirementIsIdle(store.snapshot(), current()), false)
  await tasks.removeRequirement(requirement.id)
  assert.equal(requirementIsIdle(store.snapshot(), { id: requirement.id }), false)
})

test('stage report is durable, deduplicated, retries after restart, and does not archive planning scope', async t => {
  const { root, store, service, requirement, add, accept, current } = await fixture(t)
  await accept(await add('原型交付'))
  await store.update(s => { s.requirements[0].updatedAt = Date.now() - 30_000 })
  let summaries = 0, deliveries = 0
  const worker = new RequirementWorker(store, service, { summarize: async (_r, _t, _s, stage) => { assert.ok(stage); summaries++; return '已完成三态原型' }, deliver: async () => { deliveries++; throw new Error('断网') }, warn() {} })
  await worker.tick(); await worker.close()
  assert.equal(current().status, 'planning'); assert.ok(current().stageReport); assert.equal(current().stageReport.notifiedAt, undefined)
  const restored = await PartnerStore.open(join(root, 'state.json')), restoredService = new RequirementService(restored)
  await restoredService.retry(requirement.id)
  const resumed = new RequirementWorker(restored, restoredService, { summarize: async () => assert.fail('persisted result must be reused'), deliver: async item => { assert.equal(item.stageReport.summary, '已完成三态原型'); deliveries++ }, warn() {} })
  await resumed.tick(); await resumed.tick(); await resumed.close()
  assert.equal(summaries, 1); assert.equal(deliveries, 2); assert.ok(restoredService.require(requirement.id).stageReport.notifiedAt)
  assert.equal(restoredService.require(requirement.id).status, 'planning')
  await new TaskBoardService(restored).create({ title: '后续补充', requirementId: requirement.id }, actor)
})

test('busy planning and recently changed batches wait; new tasks abort an in-flight stage summary', async t => {
  const { store, service, add, accept, current } = await fixture(t)
  await accept(await add('交付'))
  let busy = true, started, release, signal
  const began = new Promise(resolve => { started = resolve })
  const worker = new RequirementWorker(store, service, { isBusy: () => busy, summarize: async (_r, _t, s) => { signal = s; started(); return new Promise(resolve => { release = resolve }) }, deliver: async () => assert.fail('superseded summary'), warn() {} })
  await worker.tick(); assert.equal(signal, undefined)
  await store.update(s => { s.requirements[0].updatedAt = Date.now() - 30_000 })
  await worker.tick(); assert.equal(signal, undefined)
  busy = false
  const run = worker.tick(); await began
  await add('下一项'); assert.ok(signal.aborted)
  release('过时阶段结果'); await run; await worker.close()
  assert.equal(current().stageReport, undefined)
})

test('owner can explicitly archive a completed planning requirement, but never blocked work', async t => {
  const { tasks, service, requirement, add, accept, current } = await fixture(t)
  const task = await add('待确认范围')
  await tasks.update(task.id, { expectedRevision: task.revision, status: 'blocked' }, actor)
  await assert.rejects(service.finish(requirement.id, current().revision, '不能假完成', actor), /不能完成归档/)
  await accept(task)
  await service.finish(requirement.id, current().revision, '负责人确认全范围交付完毕', actor)
  assert.equal(current().status, 'done'); assert.ok(current().archivedAt)
})

test('archived continuation preserves history and accepted work, but does not resend the old batch', async t => {
  const { root, store, tasks, service, requirement, add, accept, current } = await fixture(t)
  const task = await accept(await add('已完成阶段')), oldTask = structuredClone(task)
  await service.finish(requirement.id, current().revision, '历史真实成果', actor)
  await assert.rejects(service.reopen(requirement.id, current().revision - 1, actor), /内容已更新/)
  await assert.rejects(service.reopen(requirement.id, current().revision, { kind: 'companion', companionId: 'other' }), /只有需求负责人/)
  await service.reopen(requirement.id, current().revision, actor, { description: '继续下一阶段，不修改旧交付' })
  assert.equal(current().status, 'planning'); assert.equal(current().summary, undefined); assert.equal(current().archivedAt, undefined)
  assert.equal(current().archiveHistory[0].summary, '历史真实成果')
  assert.equal(current().archiveHistory[0].results[0].id, task.id)
  assert.deepEqual(tasks.require(task.id), oldTask)
  await store.update(s => { s.requirements[0].updatedAt = Date.now() - 30_000 })
  const worker = new RequirementWorker(store, service, { summarize: async () => assert.fail('reopen alone must not resend old outcomes'), deliver: async () => assert.fail('old batch'), warn() {} })
  await worker.tick(); await worker.close()
  const next = await add('下一阶段'); await accept(next)
  const resumed = await PartnerStore.open(join(root, 'state.json')), resumedService = new RequirementService(resumed)
  assert.equal(resumedService.require(requirement.id).archiveHistory.length, 1)
  await resumedService.finish(requirement.id, resumedService.require(requirement.id).revision, '整个需求的新结论', actor)
  assert.equal(resumedService.require(requirement.id).results.length, 2)
  assert.equal(resumedService.require(requirement.id).archiveHistory[0].summary, '历史真实成果')
})

test('explicit consolidation preserves completed tasks, dependencies and sent archive, without rerun or renotification', async t => {
  const { store, tasks, service, requirement, add, accept, current } = await fixture(t)
  const first = await accept(await add('产品'))
  const source = await service.create({ title: '误建视觉需求' }, actor, 'origin-channel-session')
  const second = await accept(await tasks.create({ title: '视觉', requirementId: source.id, dependencyTaskIds: [first.id] }, actor))
  await service.finish(source.id, service.require(source.id).revision, '视觉已交付', actor)
  await store.update(s => {
    const target = s.requirements.find(r => r.id === requirement.id), sourceReq = s.requirements.find(r => r.id === source.id)
    target.stageReport = { key: requirementProgressKey(s, target), summary: '产品已交付', createdAt: 1, notifiedAt: 2 }
    sourceReq.notifiedAt = 3
  })
  const input = { targetId: requirement.id, sourceId: source.id, targetRevision: current().revision, sourceRevision: service.require(source.id).revision, title: '同一目标', description: '产品及后续视觉' }
  const before = store.snapshot()
  await assert.rejects(store.update(s => consolidateCompletedRequirements(s, { ...input, targetRevision: 0 })), /已改变/)
  assert.deepEqual(store.snapshot(), before)
  await store.update(s => consolidateCompletedRequirements(s, input))
  assert.equal(service.list().length, 1); assert.equal(tasks.snapshot().tasks.length, 2)
  assert.deepEqual(tasks.require(first.id), first)
  assert.equal(tasks.require(second.id).status, 'done'); assert.equal(tasks.require(second.id).resultSummary, second.resultSummary)
  assert.equal(tasks.require(second.id).requirementId, requirement.id); assert.deepEqual(tasks.require(second.id).dependencyTaskIds, [first.id])
  assert.equal(current().archiveHistory[0].summary, '视觉已交付'); assert.equal(current().archiveHistory[0].notifiedAt, 3)
  const merged = store.snapshot()
  await store.update(s => consolidateCompletedRequirements(s, input)); assert.deepEqual(store.snapshot(), merged)
  await store.update(s => { s.requirements[0].updatedAt = Date.now() - 30_000 })
  const worker = new RequirementWorker(store, service, { summarize: async () => assert.fail('metadata repair is not new work'), deliver: async () => assert.fail('already delivered'), warn() {} })
  await worker.tick(); await worker.close()
})

test('consolidation refuses incomplete, cross-session or undelivered requirements atomically', async t => {
  const { store, tasks, service, requirement, add, accept, current } = await fixture(t)
  await accept(await add('产品'))
  const source = await service.create({ title: '视觉' }, actor, 'origin-channel-session')
  const second = await tasks.create({ title: '视觉', requirementId: source.id }, actor)
  const input = () => ({ targetId: requirement.id, sourceId: source.id, targetRevision: current().revision, sourceRevision: service.require(source.id).revision, title: '目标', description: '' })
  await assert.rejects(store.update(s => consolidateCompletedRequirements(s, input())), /只合并/)
  await accept(second); await service.finish(source.id, service.require(source.id).revision, '真实成果', actor)
  await assert.rejects(store.update(s => consolidateCompletedRequirements(s, input())), /只合并/)
  await store.update(s => { const r = s.requirements.find(r => r.id === source.id); r.notifiedAt = 1; r.creatorSessionId = 'another-session' })
  await assert.rejects(store.update(s => consolidateCompletedRequirements(s, input())), /不同负责人或来源会话/)
  assert.equal(store.snapshot().requirements.length, 2)
})
