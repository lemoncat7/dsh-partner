import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { initializeMemoryArtifacts, applyMemoryArtifacts, readScenes, readExperienceDrafts, groundExperiences, reviewExperienceDraft, experienceMarkdown } from '../lib/memory-artifacts.js'
import { buildProfileSnapshot } from '../lib/profile-domain.js'
import { rankMemories } from '../lib/memory-retrieval.js'

const now = Date.now()
const memory = { id: 'm', companionId: 'c', scopeId: 's', kind: 'preference', subject: '协作流程', content: '开发前先确认交付边界',
  status: 'active', confidence: .9, importance: .8, updatedAt: now, createdAt: now, evidence: [{ turnId: 't1', at: now, excerpt: '先确认边界' }] }
const success = { title: '边界确认', steps: ['确认交付范围后再开发'], evidence: [{ turnId: 't1', quote: '测试通过' }, { turnId: 't2', quote: '验证通过' }] }

test('scene views immediately reflect source correction/deletion and reject foreign references', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initializeMemoryArtifacts(db)
  applyMemoryArtifacts(db, 's', [memory], [{ title: '项目 A', memoryIds: ['m'] }, { title: '项目 B', memoryIds: ['foreign'] }], [], now)
  assert.equal(readScenes(db, 's', [memory]).length, 1)
  assert.match(readScenes(db, 's', [{ ...memory, content: '新的明确约束' }])[0].summary, /新的明确约束/)
  assert.deepEqual(readScenes(db, 's', [{ ...memory, status: 'superseded' }]), [])
  assert.deepEqual(readScenes(db, 's', [{ ...memory, expiresAt: now - 1 }]), [])
  assert.deepEqual(readScenes(db, 'other', [memory]), [])
})

test('experience proposals require success confirmed by users across sessions', () => {
  const a = { id: 't1', sessionId: 'a', user: '本次测试通过', assistant: '成功' }
  const b = { id: 't2', sessionId: 'b', user: '本次验证通过', assistant: '' }
  assert.equal(groundExperiences([success], [a, b]).length, 1)
  assert.equal(groundExperiences([success], [a, { ...b, sessionId: 'a' }]).length, 0)
  assert.equal(groundExperiences([success], [a, { ...b, user: '', assistant: '验证通过' }]).length, 0)
  const negative = { ...success, evidence: [{ turnId: 't1', quote: '测试通过' }, { turnId: 't2', quote: '验证通过但是仍有问题' }] }
  assert.equal(groundExperiences([negative], [a, { ...b, user: '验证通过但是仍有问题' }]).length, 0)
  assert.equal(groundExperiences([success], [a, { ...b, user: '没有验证通过' }]).length, 0)
})

test('draft reviews use optimistic versions and are not overwritten by automatic evolution', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); initializeMemoryArtifacts(db)
  applyMemoryArtifacts(db, 's', [], [], [success], now)
  const [draft] = readExperienceDrafts(db, 's')
  assert.equal(draft.status, 'draft')
  assert.throws(() => reviewExperienceDraft(db, 's', draft.id, 'stale', 'approved'), /变化/)
  reviewExperienceDraft(db, 's', draft.id, draft.version, 'approved')
  applyMemoryArtifacts(db, 's', [], [], [{ ...success, steps: ['别的步骤'] }], now + 1)
  const [approved] = readExperienceDrafts(db, 's')
  assert.deepEqual(approved.steps, success.steps)
  assert.match(experienceMarkdown(approved), /不扩大工具权限/)
  assert.deepEqual(readExperienceDrafts(db, 'foreign'), [])
})

test('derived persona uses repeated reliable preferences, remains scoped and revokes expired evidence', () => {
  assert.equal(buildProfileSnapshot('c', 's', [memory]).preferences.length, 0)
  const repeated = { ...memory, evidence: [...memory.evidence, { turnId: 't2', at: now, excerpt: '以后都如此' }] }
  const profile = buildProfileSnapshot('c', 's', [repeated])
  assert.equal(profile.preferences.length, 1)
  assert.notEqual(profile.version, buildProfileSnapshot('c', 's', [{ ...repeated, content: '更新的偏好' }]).version)
  assert.equal(buildProfileSnapshot('c', 's', [{ ...repeated, expiresAt: now - 1 }]).preferences.length, 0)
  assert.equal(buildProfileSnapshot('c', 'foreign', [repeated]).preferences.length, 0)
})

test('unrelated high-importance memories do not fill recall slots', () => {
  assert.deepEqual(rankMemories([memory], '香蕉价格', now), [])
  assert.deepEqual(rankMemories([memory], '', now), [])
  assert.equal(rankMemories([memory], '开发交付', now).length, 1)
})
