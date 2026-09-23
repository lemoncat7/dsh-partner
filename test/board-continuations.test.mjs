import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { ScheduleContinuations, continuationPrompt } from '../lib/scheduler/continuations.js'
import { taskScheduling, executionWait } from '../lib/tasks/scheduling.js'
import { waitForBoardTurn } from '../lib/tasks/continuation-yield.js'

const owner = 'companion-default', session = 'session-board'
const actor = { kind: 'user' }
const input = { taskKey: 'provider:external-1', externalTaskId: 'external-1', title: '等待产物', check: '查询已有任务', nextStep: '下载已生成产物' }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'board-continuation-'))
  const path = join(root, 'state.json'), store = await PartnerStore.open(path)
  const board = new TaskBoardService(store)
  const service = new PartnerCollaborationService(store, {}, board, {})
  const timers = new ScheduleContinuations(store)
  timers.start()
  t.after(async () => { timers.close(); await service.close(); await rm(root, { recursive: true, force: true }) })
  await store.update(s => {
    s.companions[0].capabilities = ['schedules', 'task-board']
    s.sessions.push({ id: 'route-board', companionId: owner, sessionId: session, kind: 'local', channelId: '@local', userId: 'owner', lastMessageAt: Date.now() })
  })
  const task = await board.create({ title: '长任务', assigneeCompanionId: owner, autoRun: true }, actor)
  const defer = () => timers.defer(owner, session, { ...input, boardTaskId: task.id })
  const seed = () => store.update(s => {
    const current = s.tasks.find(t => t.id === task.id)
    current.status = 'doing'
    s.delegations.push({ id: 'delegation-test', taskId: task.id, toCompanionId: owner, initiatedBy: 'user', status: 'running', request: 'test', attempts: 1, createdAt: Date.now(), executionSessionId: session })
  })
  return { root, path, store, board, service, timers, task, defer, seed }
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)) }
  assert.fail('condition did not become true')
}

test('deferral releases execution and blocks redispatch/review until original task resumes once', async t => {
  const f = await fixture(t)
  let calls = 0, entry, notices = 0
  f.service.setSessionExecutor({ execute: async request => {
    calls++
    await f.store.update(s => { s.delegations.find(d => d.id === request.sourceId).executionSessionId = session })
    if (calls === 1) {
      const waiting = waitForBoardTurn(f.store, request.sourceId, new Promise(() => {}), request.signal)
      entry = await f.defer()
      assert.equal(await waiting, true)
      assert.equal(request.signal.aborted, false)
      return { run: { id: 'deferred' }, output: '已预约，稍后继续' }
    }
    assert.match(request.prompt, /external-1/)
    assert.match(request.prompt, /下载已生成产物/)
    return { run: { id: 'finished' }, output: '真实产物已下载并核实' }
  } })
  await f.service.start()
  await waitFor(() => Boolean(entry))
  for (let i = 0; i < 5; i++) await f.service.tick()
  assert.equal(calls, 1)
  assert.equal(f.board.require(f.task.id).status, 'doing')
  assert.equal(taskScheduling(f.store.snapshot(), f.board.require(f.task.id)).code, 'external_wait')
  await assert.rejects(f.board.completeExecution(f.task.id, '等待中', actor), /等待外部/)
  const current = f.board.require(f.task.id)
  await assert.rejects(f.board.update(current.id, { status: 'review', expectedRevision: current.revision }, actor), /等待外部/)
  f.timers.configure({ execute: async e => {
    assert.match(continuationPrompt(e), /禁止.*执行 nextStep/)
    await f.timers.resolve(owner, session, { scheduleId: e.id, runToken: e.continuation.runToken, outcome: 'pending', summary: '还在生成', delayMinutes: 5 })
  }, notify: async () => { notices++ } })
  await f.timers.run(entry.id)
  await f.service.tick()
  assert.equal(calls, 1)
  await f.timers.resolve(owner, session, { scheduleId: entry.id, externalTaskId: input.externalTaskId, outcome: 'completed', summary: '产物已生成 /result.png' })
  await f.service.tick()
  await waitFor(() => f.board.require(f.task.id).status === 'review')
  assert.equal(calls, 2)
  assert.match(f.board.require(f.task.id).resultSummary, /真实产物/)
  await f.timers.tick()
  assert.equal(notices, 0)
})

test('restart preserves waiting state and does not consume an execution slot', async t => {
  const f = await fixture(t); await f.seed(); const entry = await f.defer()
  const reopened = await PartnerStore.open(f.path)
  assert.equal(taskScheduling(reopened.snapshot(), reopened.snapshot().tasks[0]).code, 'external_wait')
  const other = { ...f.task, id: 'unrelated' }
  assert.equal(executionWait(reopened.snapshot(), other), undefined)
  assert.equal(reopened.snapshot().delegations[0].status, 'queued')
  assert.equal(reopened.snapshot().schedules[0].id, entry.id)
  const recovered = new PartnerCollaborationService(reopened, {}, new TaskBoardService(reopened), {})
  let calls = 0
  recovered.setSessionExecutor({ execute: async () => { calls++; return { run: { id: 'unexpected' }, output: 'unexpected' } } })
  await recovered.start()
  await recovered.tick()
  await recovered.close()
  assert.equal(calls, 0)
})

test('paused waits stay parked and unpausing does not wake before the timer', async t => {
  const f = await fixture(t); await f.seed(); const entry = await f.defer()
  await f.store.update(s => { s.schedules[0].enabled = false })
  assert.match(taskScheduling(f.store.snapshot(), f.board.require(f.task.id)).message, /暂停/)
  assert.equal(f.board.require(f.task.id).status, 'doing')
  await f.store.update(s => { s.schedules[0].enabled = true })
  assert.equal(executionWait(f.store.snapshot(), f.board.require(f.task.id)).code, 'external_wait')
  assert.equal(f.store.snapshot().schedules[0].id, entry.id)
})

test('legacy one-shot wait can be adopted only in the exact live board context', async t => {
  const f = await fixture(t)
  const old = await f.timers.defer(owner, session, input)
  assert.equal(old.continuation.board, undefined)
  await f.seed()
  const adopted = await f.defer()
  assert.equal(adopted.id, old.id)
  assert.equal(adopted.continuation.board.taskId, f.task.id)
  assert.equal(adopted.nextRunAt, old.nextRunAt)
})

test('implicit binding is confined to the actual execution session', async t => {
  const f = await fixture(t); await f.seed()
  await f.store.update(s => { s.delegations[0].executionSessionId = 'another-session' })
  await assert.rejects(f.defer(), /无法唯一/)
  await f.store.update(s => { s.delegations[0].executionSessionId = session })
  const entry = await f.timers.defer(owner, session, input)
  assert.equal(entry.continuation.board.taskId, f.task.id)
})

for (const action of ['delete', 'cancel', 'revoke', 'blocked']) test(`${action} stops waiting safely without resubmitting external work`, async t => {
  const f = await fixture(t); await f.seed(); const entry = await f.defer()
  if (action === 'delete') await f.store.update(s => { s.schedules = [] })
  if (action === 'cancel') await f.timers.cancel(owner, entry.id)
  if (action === 'revoke') await f.store.update(s => { s.companions[0].capabilities = [] })
  if (action === 'blocked') await f.timers.resolve(owner, session, { scheduleId: entry.id, externalTaskId: input.externalTaskId, outcome: 'blocked', summary: '外部任务失败' })
  assert.equal(f.board.require(f.task.id).status, 'blocked')
  assert.equal(f.store.snapshot().delegations[0].status, 'failed')
})

test('work edits invalidate old wake and reject its late result', async t => {
  const f = await fixture(t); await f.seed(); const entry = await f.defer()
  const task = f.board.require(f.task.id)
  await f.board.update(task.id, { description: '改为新方案', expectedRevision: task.revision }, actor)
  const schedule = f.store.snapshot().schedules[0]
  assert.equal(schedule.continuation.state, 'cancelled')
  assert.equal(schedule.enabled, false)
  await assert.rejects(f.timers.resolve(owner, session, { scheduleId: entry.id, externalTaskId: input.externalTaskId, outcome: 'completed', summary: '旧产物' }), /已结束/)
})

test('explicit binding cannot suspend another session or create two waits', async t => {
  const f = await fixture(t); await f.seed()
  await assert.rejects(f.timers.defer(owner, session, { ...input, boardTaskId: 'other' }), /无法唯一/)
  await f.defer()
  await assert.rejects(f.timers.defer(owner, session, { ...input, taskKey: 'new', boardTaskId: f.task.id }), /无法唯一|已有等待/)
  assert.equal(f.store.snapshot().schedules.length, 1)
})

test('removing task and delegation also invalidates its timer', async t => {
  const f = await fixture(t); await f.seed(); const entry = await f.defer()
  await f.store.update(s => { s.tasks = []; s.delegations = [] })
  const timer = f.store.snapshot().schedules.find(s => s.id === entry.id)
  assert.equal(timer.enabled, false)
  assert.equal(timer.continuation.state, 'cancelled')
})

test('waiting releases capacity but retains exclusive external resource ownership', async t => {
  const f = await fixture(t); await f.seed()
  await f.store.update(s => { s.tasks[0].resourceKeys = ['remote-build'] })
  await f.defer()
  assert.equal(executionWait(f.store.snapshot(), { ...f.task, id: 'independent', resourceKeys: [] }), undefined)
  assert.equal(executionWait(f.store.snapshot(), { ...f.task, id: 'conflict', resourceKeys: ['remote-build'] }).code, 'resource_busy')
})

test('reassigning a task cancels old timer without blocking the replacement', async t => {
  const f = await fixture(t); await f.seed(); await f.defer()
  await f.store.update(s => { s.companions.push({ ...s.companions[0], id: 'new-worker', name: 'new' }) })
  const task = f.board.require(f.task.id)
  await f.board.update(task.id, { assigneeCompanionId: 'new-worker', expectedRevision: task.revision }, actor)
  assert.equal(f.board.require(task.id).status, 'ready')
  assert.equal(f.store.snapshot().schedules[0].continuation.state, 'cancelled')
})
