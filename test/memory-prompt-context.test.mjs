import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DAILY_TURN_CHAR_BUDGET,
  REFLECTION_MEMORY_CHAR_BUDGET,
  compactMemories,
  compactTurns,
  dailyReviewPromptInput,
  reflectionPromptInput,
} from '../lib/memory-prompt-context.js'

const memory = (index) => ({
  id: `memory-${index}`,
  companionId: 'companion-1',
  scopeId: 'weixin:user',
  kind: index % 2 === 0 ? 'preference' : 'task',
  subject: `记忆主题 ${index}`,
  content: `记忆正文 ${index} ${'内容'.repeat(500)}`,
  status: 'active',
  confidence: .9,
  importance: .8,
  createdAt: index,
  updatedAt: index,
  evidence: Array.from({ length: 8 }, (_, evidence) => ({ turnId: `turn-${evidence}`, at: evidence, excerpt: `证据 ${evidence} ${'原文'.repeat(180)}` })),
})

const turn = (index) => ({
  id: `turn-${index}`,
  companionId: 'companion-1',
  scopeId: 'weixin:user',
  sessionId: 'session-1',
  at: index,
  user: `用户开头 ${index} ${'用户内容'.repeat(400)} 用户结尾 ${index}`,
  assistant: `助手开头 ${index} ${'助手内容'.repeat(500)} 助手结尾 ${index}`,
})

const reflection = {
  date: '2026-08-30', companionId: 'companion-1', scopeId: 'weixin:user', summary: '当日回顾',
  events: [], openTasks: [], completedTasks: [], learnings: [], updatedAt: 1, turnCount: 1,
}

test('uses a compact memory view without repeating full evidence objects', () => {
  const input = compactMemories(Array.from({ length: 16 }, (_, index) => memory(index)), 16, REFLECTION_MEMORY_CHAR_BUDGET)
  assert.equal(input.length, 16)
  assert.ok(JSON.stringify(input).length <= REFLECTION_MEMORY_CHAR_BUDGET)
  assert.equal('evidence' in input[0], false)
  assert.equal(input[0].evidenceCount, 8)
  assert.match(input[0].latestEvidence, /证据 7/)
})

test('keeps both ends of a long current turn while bounding reflection context', () => {
  const current = turn(1)
  current.user = `用户开头 ${'中间'.repeat(5_000)} 用户结尾`
  current.assistant = `助手开头 ${'中间'.repeat(5_000)} 助手结尾`
  const parsed = JSON.parse(reflectionPromptInput('2026-08-30', current, Array.from({ length: 16 }, (_, index) => memory(index)), reflection, []))
  assert.match(parsed.newTurn.user, /^用户开头/)
  assert.match(parsed.newTurn.user, /用户结尾$/)
  assert.match(parsed.newTurn.assistant, /^助手开头/)
  assert.match(parsed.newTurn.assistant, /助手结尾$/)
  assert.ok(JSON.stringify(parsed.existingRelevantMemories).length <= REFLECTION_MEMORY_CHAR_BUDGET)
})

test('retains a representative user and assistant fragment for every daily turn', () => {
  const turns = Array.from({ length: 100 }, (_, index) => turn(index))
  const compacted = compactTurns(turns, DAILY_TURN_CHAR_BUDGET)
  assert.equal(compacted.length, turns.length)
  assert.ok(compacted.every(item => item.user.length > 0 && item.assistant.length > 0))
  assert.ok(JSON.stringify(compacted).length <= DAILY_TURN_CHAR_BUDGET)
  const parsed = JSON.parse(dailyReviewPromptInput('2026-08-30', {
    reflection: { ...reflection, turnCount: turns.length },
    memories: Array.from({ length: 30 }, (_, index) => memory(index)),
    existingRelations: [],
    turns,
  }, []))
  assert.equal(parsed.turns.length, turns.length)
  assert.match(parsed.contextPolicy, /所有轮次均保留/)
  assert.ok(JSON.stringify(parsed).length < 40_000)
})

test('preserves daily open tasks while compacting review history', () => {
  const openTasks = Array.from({ length: 20 }, (_, index) => `待办 ${index} ${'细节'.repeat(100)}`)
  const parsed = JSON.parse(dailyReviewPromptInput('2026-08-30', {
    reflection: { ...reflection, openTasks },
    memories: [],
    existingRelations: [],
    turns: [turn(1)],
  }, []))
  assert.equal(parsed.reflection.openTasks.length, openTasks.length)
  assert.match(parsed.reflection.openTasks[0], /^待办 0/)
})
