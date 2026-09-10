import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { MemoryReflectionService } from '../lib/memory-reflection.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { MemoryWorker } from '../lib/memory-worker.js'

const at = Date.now()
const turn = (id, scopeId = 's') => ({ id, companionId: 'c', scopeId, sessionId: 'session', at, user: '以后用冷灰色', assistant: '收到' })
const result = { daily: { summary: '讨论界面配色', events: [], openTasks: [], completedTasks: [], learnings: [] },
  memories: [], concerns: [] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new PartnerMemoryStore(root) }
}

test('durable enqueue is duplicate-safe and expired leases recover after restart', async t => {
  const { root, store } = await fixture(t)
  await store.enqueue(turn('one'))
  await store.enqueue(turn('one'))
  const claimed = await store.claimJob('c', at)
  assert.ok(claimed)
  const restarted = new PartnerMemoryStore(root)
  assert.equal(await restarted.claimJob('c', at + 1000), undefined)
  const recovered = await restarted.claimJob('c', at + 301000)
  assert.equal(recovered.turn.id, 'one')
  await assert.rejects(store.checkpointJob(claimed, result), /lease was lost/)
  await restarted.settleJob(recovered)
  assert.equal(await restarted.claimJob('c', at + 400000), undefined)
})

test('retry backoff preserves same-scope order without blocking other scopes', async t => {
  const { store } = await fixture(t)
  await store.enqueue(turn('first'))
  await store.enqueue({ ...turn('second'), at: at + 1 })
  await store.enqueue(turn('other', 'other'))
  const job = await store.claimJob('c')
  await store.settleJob(job, 'network offline')
  const independent = await store.claimJob('c')
  assert.equal(independent.turn.id, 'other')
  await store.settleJob(independent)
  assert.equal(await store.claimJob('c'), undefined)
  const retry = await store.claimJob('c', Date.now() + 60_000)
  assert.equal(retry.turn.id, 'first')
  assert.equal(retry.attempts, 1)
})

test('cached extraction and transactional commit survive replay without double counting', async t => {
  const { root, store } = await fixture(t)
  await store.enqueue(turn('one'))
  const job = await store.claimJob('c')
  await store.checkpointJob(job, result)
  await store.consolidate(job.turn, result, job)
  await store.settleJob(job, 'downstream failure')
  const restarted = new PartnerMemoryStore(root)
  const retry = await restarted.claimJob('c', Date.now() + 60_000)
  assert.deepEqual(retry.result, result)
  await restarted.consolidate(retry.turn, retry.result, retry)
  assert.equal((await restarted.recentReflections('c'))[0].turnCount, 1)
  await restarted.settleJob(retry)
  const [target] = await restarted.pendingDailyReviews('c', restarted.day(at))
  const context = await restarted.dailyReviewContext(target)
  assert.equal(context.turns.length, 1)
  assert.equal(context.turns[0].id, 'one')
})

test('three failures yield to later same-scope jobs without losing the failed turn', async t => {
  const {store,root}=await fixture(t)
  await store.enqueue(turn('blocked'))
  await store.enqueue({...turn('later'),at:at+1})
  for(let i=0;i<3;i++) {
    const job=await store.claimJob('c',Date.now()+i*600000)
    assert.equal(job.turn.id,'blocked')
    await store.settleJob(job,'model failure')
  }
  const later=await new PartnerMemoryStore(root).claimJob('c')
  assert.equal(later.turn.id,'later')
  await store.settleJob(later)
  const layers=await store.memoryLayers('c','s')
  assert.equal(layers.jobCount,1);assert.equal(layers.retryCount,1)
  assert.equal(layers.jobs[0].attempts,3)
  await store.retryJob('c','s','blocked')
  assert.equal((await store.claimJob('c')).turn.id,'blocked')
})

test('late extraction cannot overwrite newer preferences or daily summary', async t=>{
  const {store}=await fixture(t)
  const old={...turn('old'),at:at-1000}
  const newer=turn('new')
  const memory=content=>({kind:'preference',subject:'配色',content,confidence:.9,importance:.8,operation:'upsert'})
  await store.enqueue(newer)
  const job=await store.claimJob('c')
  await store.consolidate(newer,{...result,daily:{...result.daily,summary:'最新摘要'},memories:[memory('新偏好')]},job)
  await store.settleJob(job)
  await store.consolidate(old,{...result,daily:{...result.daily,summary:'旧摘要'},memories:[memory('旧偏好')]})
  assert.equal((await store.recentMemories('c'))[0].content,'新偏好')
  assert.equal((await store.recentReflections('c'))[0].summary,'最新摘要')
})

test('reflection enqueue does not invoke a model; background failures retain work', async t => {
  const { root, store } = await fixture(t)
  let calls = 0
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { async *stream() { calls++; throw new Error('network offline') } } }
  const reflection = new MemoryReflectionService(ctx, store, new PartnerConcernStore(root))
  const companion = { id: 'c', automation: { memory: { enabled: true, retentionDays: 0 } } }
  await reflection.reflect(companion, turn('one'))
  assert.equal(calls, 0)
  await assert.rejects(reflection.processPending(companion), /network offline/)
  assert.equal(await store.hasPendingTurns('c', 's'), true)
  assert.equal(reflection.isRunning('c'), false)
})

test('history retention does not delete active long-term preferences or pending work', async t => {
  const { store } = await fixture(t)
  const old = { ...turn('old'), at: at - 90 * 86400000 }
  await store.enqueue(old)
  await store.consolidate(old, { ...result, memories: [{ kind: 'preference', subject: '配色', content: '冷灰色', confidence: .9, importance: .8, operation: 'upsert' }] })
  await store.prune('c', 30)
  assert.equal((await store.recentMemories('c')).length, 1)
  assert.equal(await store.hasPendingTurns('c', 's'), true)
})

test('history cursor retains same-time turns and contact isolation', async t => {
  const { store } = await fixture(t)
  await store.enqueue(turn('a'))
  await store.enqueue(turn('b'))
  await store.enqueue(turn('private', 'private'))
  const first = await store.history('c', 's', at + 1, 1)
  const next = await store.history('c', 's', first[0].at, 1, first[0].id)
  assert.equal(first[0].id, 'b')
  assert.equal(next[0].id, 'a')
  assert.deepEqual(await store.history('c', 'none'), [])
  const recalled = await store.recallContext('c', 's', '冷灰色')
  assert.equal(recalled.history.length, 2)
  assert.equal(recalled.history.some(item => item.id === 'private'), false)
})

test('concern retry batches do not duplicate audits or create another concern', async t => {
  const { root } = await fixture(t)
  const concerns = new PartnerConcernStore(root)
  const candidate = { subject: '版本更新', reason: '用户要求持续关注版本', operation: 'upsert', priority: .8, confidence: 1, watchKind: 'web', watchQuery: '版本更新' }
  const options = { source: 'reflection', batchId: 'turn-batch', evidence: '帮我持续关注版本更新' }
  const first = await concerns.ingestCandidates('c', 's', [candidate], 'explicit', at, options)
  const second = await concerns.ingestCandidates('c', 's', [candidate], 'explicit', at, options)
  assert.deepEqual(first, second)
  assert.equal((await concerns.list('c', 's')).length, 1)
})

test('old reflection batches cannot undo a later user dismissal', async t => {
  const { root } = await fixture(t)
  const concerns = new PartnerConcernStore(root)
  const candidate = { subject: '版本更新', reason: '持续观察', operation: 'upsert', priority: .8, confidence: 1, watchKind: 'web', watchQuery: '版本更新' }
  const [created] = await concerns.applyCandidates('c', 's', [candidate], 'explicit', at)
  await concerns.act('c', created.id, 'ignore', at + 1000)
  await concerns.applyCandidates('c', 's', [candidate], 'explicit', at, { batchId: 'older' })
  await concerns.act('c', created.id, 'watch', at)
  assert.equal((await concerns.list('c', 's', true))[0].state, 'archived')
})

test('worker respects opt-out, removal, shutdown and continues after a failed companion', async () => {
  const companion = (id, enabled = true) => ({ id, automation: { memory: { enabled } } })
  const processed = []; const warnings = []
  const worker = new MemoryWorker({ companions: () => [companion('off', false), companion('deleted'), companion('failed'), companion('ok')],
    removing: id => id === 'deleted', process: async c => { processed.push(c.id); if (c.id === 'failed') throw new Error('offline') },
    warn: message => warnings.push(message) })
  await worker.tick()
  assert.deepEqual(processed, ['failed', 'ok'])
  assert.equal(warnings.length, 1)
  await worker.close()
  await worker.tick()
  assert.equal(processed.length, 2)
})

test('a completed cached job retries failed notification without another model call', async t => {
  const { root, store } = await fixture(t)
  const concerns = new PartnerConcernStore(root)
  const [created] = await concerns.applyCandidates('c', 's', [{ subject: '版本', reason: '持续关注', operation: 'upsert', priority: .8, confidence: 1, watchKind: 'web', watchQuery: '版本' }], 'explicit', at)
  const reflection = new MemoryReflectionService({ logger: { warn() {} } }, store, concerns)
  // Exercise the durable replay boundary independently of model/concern policy.
  reflection.applyConcerns = async () => [created]
  await store.enqueue(turn('notify'))
  const claim = await store.claimJob('c')
  await store.checkpointJob(claim, result)
  await store.settleJob(claim, 'temporary')
  await store.retryJob('c', 's', 'notify')
  const companion = { id: 'c', automation: { memory: { retentionDays: 0 } } }
  await assert.rejects(reflection.processPending(companion, async () => { throw new Error('delivery failed') }), /delivery failed/)
  assert.equal((await store.recentReflections('c'))[0].turnCount, 1)
  await store.retryJob('c', 's', 'notify')
  await reflection.processPending(companion, async () => {})
  assert.equal((await store.recentReflections('c'))[0].turnCount, 1)
  assert.equal(await store.hasPendingTurns('c', 's'), false)
})
