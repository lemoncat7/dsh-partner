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
  await assert.rejects(service.submit(requirement.id, stale, actor), /内容已更新/)
  await assert.rejects(service.submit(requirement.id, current().revision, { kind: 'companion', companionId: 'other' }), /只有需求负责人/)
  await assert.rejects(service.assignOwner(requirement.id, current().revision, 'missing'), /不存在/)
  await service.assignOwner(requirement.id, current().revision, undefined)
  assert.equal(current().ownerCompanionId, undefined)
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
