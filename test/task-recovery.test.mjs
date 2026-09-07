import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'

const actor = { kind: 'companion', companionId: 'companion-default' }
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('task did not reach expected state')
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-review-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const board = new TaskBoardService(store)
  const task = await board.create({ title: '恢复待验收交付', assigneeCompanionId: actor.companionId }, actor)
  return { root, store, board, task }
}
function serviceFor(t, store, board, execute) {
  const service = new PartnerCollaborationService(store, {}, board, {})
  service.setSessionExecutor({ execute })
  t.after(() => service.close())
  return service
}
async function seedReview(store, task, status = 'running') {
  const now = Date.now()
  await store.update(s => {
    Object.assign(s.tasks.find(x => x.id === task.id), { status: 'review', updatedAt: now - 3_000 })
    s.delegations.push({ id: 'interrupted', kind: 'task', taskId: task.id, initiatedBy: 'user',
      toCompanionId: actor.companionId, request: '完成交付', status, attempts: 1,
      createdAt: now - 10_000, lastAttemptAt: now - 9_000, nextAttemptAt: now - 1,
      ...(status === 'canceled' ? { completedAt: now - 1_000, error: '任务或负责人已改变，取消旧执行' } : {}),
    })
    s.taskActivities.push({ id: 'shutdown', taskId: task.id, actor: 'system', kind: 'retrying',
      message: '服务正在停止，执行已安全放回恢复队列', at: now - 2_000 })
  })
}

for (const status of ['running', 'queued', 'canceled']) {
  test(`restart resumes unfinished review (${status}) once and delivers its result`, async t => {
    const { root, store, task } = await fixture(t)
    await seedReview(store, task, status)
    const restored = await PartnerStore.open(join(root, 'state.json'))
    const board = new TaskBoardService(restored)
    const notices = []
    board.setProgressNotifier(async task => notices.push(task.resultSummary))
    let calls = 0
    const service = serviceFor(t, restored, board, async ({ prompt }) => {
      calls++
      assert.equal(board.require(task.id).status, 'doing')
      assert.match(prompt, /中断后的第 2 次恢复执行/)
      assert.match(prompt, /先检查工作目录/)
      return { run: { id: 'resumed' }, output: '恢复后完整交付' }
    })
    await service.start()
    await waitFor(() => restored.snapshot().delegations[0].status === 'completed')
    await service.dispatchReadyTasks()
    assert.equal(calls, 1)
    assert.equal(board.require(task.id).status, 'review')
    assert.deepEqual(notices, ['恢复后完整交付'])
    await service.close()
    const again = serviceFor(t, restored, board, async () => { calls++; throw Error('must not rerun') })
    await again.start()
    assert.equal(calls, 1)
  })
}

test('early review followed by graceful shutdown resumes from persisted queue', async t => {
  const { root, store, board, task } = await fixture(t)
  let interrupt
  const pending = new Promise((_, reject) => { interrupt = reject })
  const first = serviceFor(t, store, board, async () => {
    const current = board.require(task.id)
    await board.update(task.id, { expectedRevision: current.revision, status: 'review' }, actor)
    return pending
  })
  await first.delegate({ taskId: task.id, initiatedBy: 'user', to: actor.companionId, request: '交付' })
  await waitFor(() => board.require(task.id).status === 'review')
  first.beginShutdown()
  interrupt(Error('service stopping'))
  await first.close()
  assert.equal(store.snapshot().delegations[0].status, 'queued')
  const restored = await PartnerStore.open(join(root, 'state.json'))
  const secondBoard = new TaskBoardService(restored)
  const second = serviceFor(t, restored, secondBoard, async () => ({ run: { id: 'second' }, output: '重启后补齐结果' }))
  await second.start()
  await waitFor(() => secondBoard.require(task.id).resultSummary === '重启后补齐结果')
})

test('transient failure after early review retries without restarting the service', async t => {
  const { store, board, task } = await fixture(t)
  let calls = 0
  const service = serviceFor(t, store, board, async () => {
    if (++calls === 1) {
      const current = board.require(task.id)
      await board.update(task.id, { expectedRevision: current.revision, status: 'review' }, actor)
      throw new TypeError('fetch failed: ECONNRESET')
    }
    return { run: { id: 'retry' }, output: '网络恢复后交付' }
  })
  await service.delegate({ taskId: task.id, initiatedBy: 'user', to: actor.companionId, request: '交付' })
  await waitFor(() => store.snapshot().delegations[0].status === 'queued')
  // Let the failed executor unwind, then exercise the same live coordinator.
  await new Promise(resolve => setImmediate(resolve))
  await store.update(s => { s.delegations[0].nextAttemptAt = 0 })
  await service.dispatchReadyTasks()
  await waitFor(() => board.require(task.id).resultSummary === '网络恢复后交付')
  assert.equal(calls, 2)
})

const protectedCases = {
  'saved result': s => { s.tasks[0].resultSummary = '已提交结果' },
  'saved review': s => { s.tasks[0].reviewSummary = '已核验' },
  'done task': s => { s.tasks[0].status = 'done' },
  'blocked task': s => { s.tasks[0].status = 'blocked' },
  'planning task': s => { s.tasks[0].status = 'backlog' },
  'changed assignee': s => { s.tasks[0].assigneeCompanionId = 'other' },
  'manual cancellation': s => { s.delegations[0].error = '用户取消任务' },
  'no shutdown evidence': s => { s.taskActivities = [] },
  'edited after cancellation': s => { s.tasks[0].updatedAt = Date.now() },
  'revoked access': s => { Object.assign(s.delegations[0], { initiatedBy: 'companion', fromCompanionId: 'removed' }) },
  'superseded delegation': s => { s.delegations.push({ ...s.delegations[0], id: 'newer', status: 'completed' }) },
}
for (const [name, mutate] of Object.entries(protectedCases)) {
  test(`legacy repair preserves ${name}`, async t => {
    const { store, board, task } = await fixture(t)
    await seedReview(store, task, 'canceled')
    await store.update(mutate)
    const before = board.require(task.id)
    let calls = 0
    const service = serviceFor(t, store, board, async () => { calls++; throw Error('must not execute') })
    await service.start()
    assert.equal(calls, 0)
    assert.equal(store.snapshot().delegations[0].status, 'canceled')
    assert.deepEqual(board.require(task.id), before)
  })
}

test('queued incomplete review still waits for accepted dependencies and current authorization', async t => {
  const { store, board, task } = await fixture(t)
  const dependency = await board.create({ title: '前置交付' }, actor)
  await seedReview(store, task, 'queued')
  await store.update(s => { s.tasks[0].dependencyTaskIds = [dependency.id] })
  let calls = 0
  const service = serviceFor(t, store, board, async () => { calls++; return { run: { id: 'work' }, output: '产出' } })
  await service.start()
  assert.equal(calls, 0)
  assert.equal(store.snapshot().delegations[0].status, 'queued')
  await store.update(s => { Object.assign(s.delegations[0], { initiatedBy: 'companion', fromCompanionId: 'removed' }) })
  await service.dispatchReadyTasks()
  assert.equal(calls, 0)
  assert.equal(store.snapshot().delegations[0].status, 'canceled')
})
