import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { PartnerSchedulerService } from '../lib/scheduler/service.js'
import { ScheduleContinuations, continuationPrompt } from '../lib/scheduler/continuations.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { deliverScheduledWake } from '../lib/scheduler/wakeup.js'
const owner = 'companion-default', session = 'session-wakeup'
const input = { taskKey: 'video:job-1', externalTaskId: 'job-1', title: '等待视频', check: '读取 job-1 的状态，不重新生成', nextStep: '确认文件后下载，不重复下载' }
test('own receipt releases wake without waiting for conversation; another task stays enabled', async t => {
  const f = await fixture(t), first = await f.service.defer(owner, session, input)
  const second = await f.service.defer(owner, session, { ...input, taskKey: 'job-2', externalTaskId: 'job-2' })
  let delivered = 0
  f.service.configure({ execute: (entry, companion, signal) => deliverScheduledWake({ store: f.store, id: entry.id, token: entry.continuation.runToken, signal, timeoutMs: 1000,
    deliver: () => { delivered++; void outcome(f, entry) } }), notify: async () => {} })
  await f.service.run(first.id)
  assert.equal(delivered, 1); assert.equal(f.get(first.id).enabled, false)
  assert.equal(f.get(second.id).enabled, true); assert.equal(f.get(second.id).continuation.attempts, 0)
})

test('early completion needs originating session and exact external identity, independent of Goal', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  const value = { scheduleId: entry.id, externalTaskId: 'wrong', outcome: 'completed', summary: 'verified output' }
  await assert.rejects(f.service.resolve(owner, session, value))
  value.externalTaskId = input.externalTaskId
  await assert.rejects(f.service.resolve(owner, 'wrong-session', value))
  await f.service.resolve(owner, session, value)
  assert.equal(f.get(entry.id).enabled, false); assert.equal(f.get(entry.id).continuation.checks, 1)
  assert.equal(f.get(entry.id).continuation.attempts, 0)
})

test('wake timeout blocks only its schedule and stale notices are not delivered', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive))
  f.service.configure({ execute: (e, c, signal) => deliverScheduledWake({ store: f.store, id: e.id, token: e.continuation.runToken, signal, timeoutMs: 20, deliver: () => {} }), notify: async () => {} })
  await f.service.run(entry.id)
  assert.equal(f.get(entry.id).continuation.state, 'blocked')
  assert.match(f.get(entry.id).continuation.summary, /原会话未被中断/)
  await deliverScheduledWake({ store: f.store, id: entry.id, token: 'stale', signal: new AbortController().signal, timeoutMs: 100, deliver: () => assert.fail('stale delivery') })
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-wakeup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json'), store = await PartnerStore.open(path)
  await store.update(s => { s.companions[0].capabilities = ['schedules']; s.sessions.push({ id: 'route-wakeup', companionId: owner, sessionId: session, kind: 'local', channelId: '@local', userId: 'owner', lastMessageAt: Date.now() }) })
  const service = new ScheduleContinuations(store)
  service.start(); t.after(() => service.close())
  const get = id => store.snapshot().schedules.find(s => s.id === id)
  return { root, path, store, service, get }
}
async function outcome(f, entry, result = 'completed', extra = {}) {
  return f.service.resolve(owner, session, { scheduleId: entry.id, runToken: entry.continuation.runToken, outcome: result, summary: '真实检查结果', ...extra })
}

test('origin channel persists across restart and idempotent defer cannot retarget it', async t => {
  const f=await fixture(t)
  const origin={id:'matrix',kind:'channel',companionId:owner,sessionId:session,channelId:'mx',userId:'alice',lastMessageAt:Date.now()}
  const other={...origin,id:'mattermost',channelId:'mm',userId:'bob'}
  await f.store.update(s=>s.sessions.push(origin,other))
  const entry=await f.service.defer(owner,session,input,origin)
  const retry=await f.service.defer(owner,session,input,other)
  assert.deepEqual(retry.continuation.originChannel,{routeId:'matrix',channelId:'mx',userId:'alice'})
  const reopened=await PartnerStore.open(f.path)
  assert.deepEqual(reopened.snapshot().schedules[0].continuation.originChannel,entry.continuation.originChannel)
  await assert.rejects(f.service.defer(owner,session,{...input,taskKey:'new'}, {...origin,userId:'forged'}),/来源渠道已变更/)
})

test('blocked standalone receipt can be verified completed, without stale tokens or foreign sessions', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  let notices = 0
  f.service.configure({execute: e => outcome(f, e, 'blocked'), notify: async () => {notices++}})
  await f.service.run(entry.id)
  assert.equal(notices, 0)
  const verified = {scheduleId: entry.id, externalTaskId: input.externalTaskId, outcome: 'completed', summary: '核实已有产出'}
  await assert.rejects(f.service.resolve(owner, 'other', verified))
  await assert.rejects(f.service.resolve(owner, session, {...verified, runToken: 'stale'}))
  await assert.rejects(f.service.resolve(owner, session, {...verified, externalTaskId: 'other'}))
  await f.service.resolve(owner, session, verified)
  assert.equal(f.get(entry.id).continuation.state, 'completed')
  assert.equal(f.get(entry.id).continuation.notifiedAt, undefined)
})

test('final reply retries durably after status notice and survives reopening storage', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  f.service.configure({execute: e => outcome(f, e, 'blocked'), notify: async () => {}})
  await f.service.run(entry.id)
  await f.store.update(s => {s.schedules[0].continuation.finalReply = {key: 'final-turn', text: 'final', referenceTexts: []}})
  let attempts = 0
  f.service.configure({execute: async () => assert.fail('must not rerun generation'), notify: async e => {
    assert.equal(e.continuation.finalReply.text, 'final'); attempts++; if (attempts === 1) throw new Error('offline')
  }})
  await f.service.notify(entry.id)
  assert.ok(f.get(entry.id).continuation.finalReply.nextNotifyAt > Date.now())
  const reopened = await PartnerStore.open(f.path)
  assert.equal(reopened.snapshot().schedules[0].continuation.finalReply.text, 'final')
  await f.service.notify(entry.id); assert.equal(attempts, 1)
  await f.store.update(s => {s.schedules[0].continuation.finalReply.nextNotifyAt = 0})
  await f.service.notify(entry.id); await f.service.notify(entry.id)
  assert.equal(attempts, 2)
  assert.ok(f.get(entry.id).continuation.finalReply.notifiedAt)
})

test('defer needs schedules, owned session, valid bounds; concurrent retries share one durable entry', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.defer(owner, 'other-session', input), /正式会话/)
  await assert.rejects(f.service.defer(owner, session, { ...input, delayMinutes: 0 }), /整数/)
  const entries = await Promise.all([f.service.defer(owner, session, input), f.service.defer(owner, session, input)])
  assert.equal(entries[0].id, entries[1].id); assert.equal(f.store.snapshot().schedules.length, 1)
  await assert.rejects(f.service.defer(owner, session, { ...input, externalTaskId: 'other' }), /taskKey/)
  assert.equal((await PartnerStore.open(f.path)).snapshot().schedules[0].id, entries[0].id)
  await f.store.update(s => { s.companions[0].capabilities = [] })
  await assert.rejects(f.service.defer(owner, session, input), /勾选/)
})

test('pending reuses entry, completion notifies once, late token and manual replay are rejected', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  let calls = 0, notifications = 0, stale
  f.service.configure({ busy: () => false, execute: async e => { calls++; stale ??= e; await outcome(f, e, calls === 1 ? 'pending' : 'completed', { delayMinutes: 4 }) }, notify: async () => { notifications++ } })
  await f.service.run(entry.id)
  assert.equal(f.get(entry.id).continuation.state, 'waiting'); assert.equal(notifications, 0)
  assert.ok(f.get(entry.id).nextRunAt > Date.now() + 230_000)
  await assert.rejects(outcome(f, stale), /轮次已结束/)
  await f.service.run(entry.id)
  assert.equal(f.get(entry.id).continuation.state, 'completed'); assert.equal(notifications, 0)
  await f.service.run(entry.id); await f.service.tick()
  assert.equal(calls, 2); assert.equal(notifications, 0)
  assert.equal((await f.service.defer(owner, session, input)).continuation.attempts, 2)
})

test('disabled capability cannot be woken', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  let calls = 0, busy = true
  f.service.configure({ busy: () => busy, execute: async e => { calls++; await outcome(f, e) }, notify: async () => {} })
  busy = false; await f.store.update(s => { s.companions[0].capabilities = [] })
  await f.service.run(entry.id); assert.equal(calls, 0)
  await f.store.update(s => { s.companions[0].capabilities = ['schedules'] })
  await f.service.run(entry.id); assert.equal(calls, 1)
})

test('cancellation aborts active execution, rejects late writes and suppresses notifications', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  let started, captured, aborted = false, notices = 0
  const ready = new Promise(resolve => { started = resolve })
  f.service.configure({ busy: () => false, execute: (e, c, signal) => new Promise((resolve, reject) => {
    captured = e; signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }); started()
  }), notify: async () => { notices++ } })
  const run = f.service.run(entry.id); await ready
  await f.service.cancel(owner, entry.id); await run
  assert.equal(aborted, true); assert.equal(notices, 0); assert.equal(f.get(entry.id).continuation.state, 'cancelled')
  await assert.rejects(outcome(f, captured), /轮次已结束/)
})

test('capability revocation aborts an active wake-up and never sends a result', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  let started, notices = 0
  const ready = new Promise(resolve => { started = resolve })
  f.service.configure({ busy: () => false, execute: (e, c, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('revoked'))); started() }), notify: async () => { notices++ } })
  const run = f.service.run(entry.id); await ready
  await f.store.update(s => { s.companions[0].capabilities = [] }); await run
  assert.equal(f.get(entry.id).continuation.state, 'blocked'); assert.equal(notices, 0)
})

test('missing outcome is blocked, exhausted attempts do not spin, invalid outcome cannot overwrite', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, { ...input, maxAttempts: 1 })
  f.service.configure({ busy: () => false, execute: async e => {
    await assert.rejects(f.service.resolve(owner, session, { scheduleId: e.id, runToken: e.continuation.runToken, outcome: 'made-up', summary: 'x' }), /outcome/)
    await outcome(f, e, 'pending')
  }, notify: async () => {} })
  await f.service.run(entry.id); assert.equal(f.get(entry.id).continuation.state, 'blocked')
  const second = await f.service.defer(owner, session, { ...input, taskKey: 'video:job-2', externalTaskId: 'job-2' })
  f.service.configure({ busy: () => false, execute: async () => {}, notify: async () => {} })
  await f.service.run(second.id); assert.match(f.get(second.id).continuation.summary, /未提交续接结果/)
})

test('restart recovers persisted running work by checking existing job with a new token', async t => {
  const f = await fixture(t), entry = await f.service.defer(owner, session, input)
  await f.store.update(s => { const wake = s.schedules[0].continuation; wake.state = 'running'; wake.attempts = 1; wake.runToken = 'old-run' })
  const store = await PartnerStore.open(f.path), recovered = new ScheduleContinuations(store)
  t.after(() => recovered.close())
  recovered.configure({ busy: () => false, execute: async e => {
    assert.equal(e.continuation.attempts, 2); assert.notEqual(e.continuation.runToken, 'old-run')
    assert.match(continuationPrompt(e), /不可重复提交/)
    await recovered.resolve(owner, session, { scheduleId: e.id, runToken: e.continuation.runToken, outcome: 'completed', summary: '核实已有产出' })
  }, notify: async () => {} })
  await recovered.run(entry.id); assert.equal(store.snapshot().schedules[0].continuation.state, 'completed')
})

test('scheduler HTTP/service entrypoints enforce capability; one-shot entries cannot become recurring', async t => {
  const f = await fixture(t), scheduler = new PartnerSchedulerService(f.store, { execute: async () => {} }, 'UTC')
  t.after(() => scheduler.close())
  const entry = await f.service.defer(owner, session, input)
  await assert.rejects(scheduler.update(entry.id, { schedule: { kind: 'interval', minutes: 5 } }), /只支持暂停/)
  await f.store.update(s => { s.companions[0].capabilities = [] })
  await assert.rejects(scheduler.trigger(entry.id), /勾选/)
  await assert.rejects(scheduler.create({ title: 'x', prompt: 'x', schedule: { kind: 'interval', minutes: 5 } }, owner), /勾选/)
  await assert.rejects(scheduler.update(entry.id, { enabled: true }), /勾选/)
})

test('built-in continuation skill is optional, trusted inline and never automatically bound', async t => {
  const f = await fixture(t), skills = new SkillService(f.store, new SkillRepository(join(f.root, 'skills')))
  await skills.initialize()
  const installed = await skills.installMarket('builtin', 'long-task-continuation')
  assert.equal(installed.executionContext, 'inline'); assert.equal(skills.bindings(owner).length, 0)
  assert.match((await skills.load(installed.id)).body, /没有本技能也可以/)
  assert.equal((await f.service.defer(owner, session, input)).continuation.state, 'waiting')
})
