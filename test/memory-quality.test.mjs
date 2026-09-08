import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groundMemoryCandidates } from '../lib/memory-quality.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'

const daily = { summary: '', events: [], openTasks: [], completedTasks: [], learnings: [] }
const turn = { id: 't1', companionId: 'c1', scopeId: 's1', sessionId: 'session', at: Date.now(), user: '以后界面采用冷灰色。', assistant: '你是设计师。' }
const candidate = { kind: 'preference', subject: '界面配色', content: '界面采用冷灰色', confidence: .9, importance: .8, operation: 'upsert' }

test('memory evidence must resolve to user speech, not assistant text or an ambiguous turn', () => {
  assert.equal(groundMemoryCandidates([{ ...candidate, evidenceQuote: '你是设计师' }], [turn]).length, 0)
  assert.equal(groundMemoryCandidates([candidate], [turn]).length, 0)
  const proposal = { ...candidate, evidenceQuote: '以后界面采用冷灰色。' }
  const other = { ...turn, id: 't2' }
  assert.equal(groundMemoryCandidates([proposal], [turn, other]).length, 0)
  const [result] = groundMemoryCandidates([{ ...proposal, sourceTurnId: 't2' }], [turn, other])
  assert.deepEqual(result.sourceEvidence, { turnId: 't2', at: turn.at, excerpt: proposal.evidenceQuote })
})

test('ID-based correction keeps identity, lowers confidence, renews durable memory and preserves locks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-quality-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  await store.consolidate({ ...turn, at: 1000 }, { daily, memories: [{ ...candidate, expiresInDays: 1 }] })
  const [before] = await store.recentMemories('c1')
  assert.equal(before.status, 'expired')
  await store.consolidate({ ...turn, id: 't2' }, { daily, memories: [{ ...candidate, subject: '冷灰材质偏好', targetMemoryId: before.id, confidence: .7 }] })
  const [after] = await store.recentMemories('c1')
  assert.equal(after.id, before.id)
  assert.equal(after.subject, before.subject)
  assert.equal(after.confidence, .7)
  assert.equal(after.expiresAt, undefined)
  assert.equal(after.status, 'active')
  await store.consolidate(turn, { daily, memories: [{ ...candidate, targetMemoryId: 'missing' }] })
  await store.consolidate({ ...turn, scopeId: 'other' }, { daily, memories: [{ ...candidate, targetMemoryId: before.id }] })
  assert.equal((await store.recentMemories('c1')).length, 1)
  await store.updateMemory('c1', before.id, before.subject, '手动确认')
  await store.consolidate(turn, { daily, memories: [{ ...candidate, targetMemoryId: before.id, operation: 'remove' }] })
  assert.equal((await store.recentMemories('c1'))[0].content, '手动确认')
})

test('Chinese topic recall ranks partial matching content ahead of unrelated importance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-quality-recall-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  await store.consolidate(turn, { daily, memories: [candidate, { ...candidate, subject: '早餐选择', content: '喜欢面包', importance: .95 }] })
  assert.equal((await store.recall('c1', 's1', '界面采用冷灰色怎么样', 1))[0].subject, '界面配色')
})

test('completion keeps the real evidence turn rather than a synthetic daily review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-quality-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  await store.consolidate(turn, { daily, memories: [{ ...candidate, kind: 'task' }] })
  const [saved] = await store.recentMemories('c1')
  const source = { ...turn, id: 'finished', user: '这件事已经完成了' }
  const grounded = groundMemoryCandidates([{ ...candidate, kind: 'task', operation: 'complete', targetMemoryId: saved.id,
    evidenceQuote: source.user, sourceTurnId: source.id }], [source])
  await store.consolidate({ ...turn, id: 'daily-review', user: '每日终审' }, { daily, memories: grounded })
  const [completed] = await store.recentMemories('c1')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.evidence.at(-1).turnId, 'finished')
  assert.equal(completed.evidence.at(-1).excerpt, source.user)
})
