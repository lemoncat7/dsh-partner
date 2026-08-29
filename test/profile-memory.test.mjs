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
