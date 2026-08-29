import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { parseReflection } from '../lib/memory-reflection.js'

const daily = { summary: '', events: [], openTasks: [], completedTasks: [], learnings: [] }
const turn = (id, at, user = '用户说明了自己的长期情况') => ({
  id, companionId: 'companion-1', scopeId: 'weixin-1:user-1', sessionId: 'session-1', at, user, assistant: '知道了',
})
const memory = (kind, subject, content, confidence, importance) => ({ kind, subject, content, confidence, importance, operation: 'upsert' })

test('builds a stable user profile separately from topic recall', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-profile-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  await store.consolidate(turn('turn-1', 1_000), { daily, memories: [
    memory('profile', '工作背景', '用户长期从事软件开发。', .91, .82),
    memory('profile', '长期目标', '用户可能想学习绘画。', .61, .7),
    memory('preference', '界面风格', '长期工作界面偏好克制的中性色。', .9, .76),
  ] })

  const context = await store.recallContext('companion-1', 'weixin-1:user-1', '软件开发界面', 12)
  assert.deepEqual(context.profile.entries.map(item => item.subject), ['工作背景'])
  assert.equal(context.profile.evidenceCount, 1)
  assert.ok(context.profile.version.length === 12)
  assert.equal(context.relevant.some(item => item.subject === '工作背景'), false)
  assert.equal(context.relevant.some(item => item.subject === '界面风格'), true)
  assert.equal(context.relevant.some(item => item.subject === '长期目标'), false)

  await store.consolidate(turn('turn-2', 2_000), { daily, memories: [memory('profile', '工作背景', '用户长期从事软件开发。', .93, .84)] })
  const refreshed = await store.profileSnapshot('companion-1', 'weixin-1:user-1')
  assert.equal(refreshed.version, context.profile.version)
  assert.equal(refreshed.evidenceCount, 2)
})

test('keeps a user-confirmed profile entry authoritative', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-profile-lock-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  await store.consolidate(turn('turn-1', 1_000), { daily, memories: [memory('profile', '职业背景', '用户从事设计。', .9, .8)] })
  const [created] = await store.recentMemories('companion-1')
  assert.ok(created)
  await store.updateMemory('companion-1', created.id, '工作背景', '用户明确确认自己从事软件开发。')
  const before = await store.profileSnapshot('companion-1', 'weixin-1:user-1')

  await store.consolidate(turn('turn-2', 2_000, '一次含混的工作讨论'), { daily, memories: [memory('profile', '工作背景', '用户从事市场营销。', .99, .99)] })
  const after = await store.profileSnapshot('companion-1', 'weixin-1:user-1')
  assert.equal(after.entries[0]?.content, '用户明确确认自己从事软件开发。')
  assert.equal(after.entries[0]?.locked, true)
  assert.equal(after.version, before.version)
})

test('normalizes automatic profile slots and rejects free-form profile labels', () => {
  const parsed = parseReflection(JSON.stringify({
    daily,
    memories: [
      memory('profile', '职业背景', '用户从事软件开发。', .9, .8),
      memory('profile', '性格画像', '用户似乎比较内向。', .8, .7),
    ],
    concerns: [],
  }))
  assert.deepEqual(parsed.memories.map(item => item.subject), ['工作背景'])
})

test('expands topic recall through a strong one-hop memory relation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-relation-recall-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  const at = Date.parse('2026-08-27T08:00:00Z')
  const relationTurn = turn('turn-relation', at, '继续部署关系召回')
  relationTurn.companionId = 'companion-relation'
  relationTurn.scopeId = 'weixin:contact-a'
  await store.consolidate(relationTurn, { daily, memories: [
    memory('task', '部署关系召回', '需要验证关系召回的部署结果。', .96, .92),
    memory('preference', '发布约束', '正式发布前必须先让用户确认预览。', .7, .08),
    ...Array.from({ length: 10 }, (_, index) => memory('event', `无关事件 ${index + 1}`, `这是与当前查询无关的高权重记录 ${index + 1}。`, .99, .99)),
  ] })
  const [target] = await store.pendingDailyReviews(relationTurn.companionId, '2026-08-27')
  await store.completeDailyReview(target, { daily, memories: [], concerns: [], relations: [{
    sourceSubject: '部署关系召回', sourceKind: 'task', targetSubject: '发布约束', targetKind: 'preference',
    kind: 'depends_on', label: '部署必须遵守发布约束', confidence: .94, operation: 'upsert',
  }] })

  const context = await store.recallContext(relationTurn.companionId, relationTurn.scopeId, '部署关系召回', 9)
  assert.equal(context.relevant.some(item => item.subject === '发布约束'), true)
  assert.equal(context.connections.length, 1)
  assert.equal(context.connections[0]?.relation.kind, 'depends_on')
  assert.deepEqual([context.connections[0]?.source.scopeId, context.connections[0]?.target.scopeId], [relationTurn.scopeId, relationTurn.scopeId])
})

test('keeps conflict connections isolated to their contact scope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-relation-scope-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const store = new PartnerMemoryStore(root)
  const at = Date.parse('2026-08-28T08:00:00Z')
  const contactA = { ...turn('turn-contact-a', at), companionId: 'companion-scope', scopeId: 'weixin:contact-a' }
  const contactB = { ...turn('turn-contact-b', at + 1), companionId: 'companion-scope', scopeId: 'weixin:contact-b' }
  const candidates = [
    memory('preference', '发布方式', '用户要求先预览再发布。', .9, .8),
    memory('event', '发布指令', '用户要求直接发布。', .86, .75),
  ]
  await store.consolidate(contactA, { daily, memories: candidates })
  await store.consolidate(contactB, { daily, memories: candidates })
  const targets = await store.pendingDailyReviews(contactA.companionId, '2026-08-28')
  const targetA = targets.find(item => item.scopeId === contactA.scopeId)
  assert.ok(targetA)
  await store.completeDailyReview(targetA, { daily, memories: [], concerns: [], relations: [{
    sourceSubject: '发布方式', sourceKind: 'preference', targetSubject: '发布指令', targetKind: 'event',
    kind: 'conflicts_with', label: '发布时机尚未确认', confidence: .91, operation: 'upsert',
  }] })

  const contextA = await store.recallContext(contactA.companionId, contactA.scopeId, '发布方式', 8)
  const contextB = await store.recallContext(contactB.companionId, contactB.scopeId, '发布方式', 8)
  assert.equal(contextA.connections.some(item => item.relation.kind === 'conflicts_with'), true)
  assert.deepEqual(contextB.connections, [])
})
