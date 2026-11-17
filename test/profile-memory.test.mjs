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

test('recent memory limits apply within a contact rather than hiding other contacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-scope-'))
  t.after(async () => rm(root, {recursive: true, force: true}))
  const store = new PartnerMemoryStore(root)
  await store.consolidate(turn('first', 1000), {daily, memories: [memory('profile', '早期联系人', '明确背景', .95, .8)]})
  await store.consolidate({...turn('second', 2000), scopeId: 'other'}, {daily, memories: [memory('profile', '另一联系人', '新的背景', .95, .8)]})
  assert.equal((await store.recentMemories('companion-1', 1))[0].scopeId, 'other')
  assert.equal((await store.recentMemories('companion-1', 1, 'weixin-1:user-1'))[0].subject, '早期联系人')
  assert.deepEqual(await store.recentMemories('companion-1', 1, 'missing'), [])
})

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


test('repeated preferences retain distinct supporting evidence and corrections clear old emphasis',async t=>{
 const {preferenceEvidenceCount,preferenceEmphasis}=await import('../lib/profile-domain.js')
 const {renderTaskPreferences}=await import('../lib/execution/task-preferences.js')
 const root=await mkdtemp(join(tmpdir(),'partner-emphasis-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=new PartnerMemoryStore(root)
 const first=memory('preference','参考资料使用','涉及自己的生图，有参考图时作为实际输入。',.96,.85)
 await store.consolidate(turn('one',1000,'画自己时用已有参考图'),{daily,memories:[first]})
 let [m]=await store.recentMemories('companion-1')
 const repeat={...first,targetMemoryId:m.id,reaffirm:true}
 await store.consolidate(turn('two',2000,'再次强调参考图要实际输入'),{daily,memories:[repeat]})
 await store.consolidate(turn('three',3000,'再说一次，必须带已有参考图'),{daily,memories:[repeat]})
 // The same source turn may be extracted again by a daily review.
 await store.consolidate(turn('review',4000),{daily,memories:[{...repeat,sourceEvidence:{turnId:'three',at:3000,excerpt:'再说一次，必须带已有参考图'}}]})
 let profile=await store.profileSnapshot('companion-1','weixin-1:user-1');m=profile.preferences[0]
 assert.equal(preferenceEvidenceCount(m),3);assert.match(preferenceEmphasis(m),/反复强调/)
 assert.match(renderTaskPreferences(profile),/实际输入/);assert.doesNotMatch(renderTaskPreferences(profile),/用户说明了|知道了/)
 const version=profile.version
 await store.consolidate(turn('correction',5000,'以后只有我明确要求时才用参考图'),{daily,memories:[{...first,targetMemoryId:m.id,content:'仅用户明确要求时使用参考图。'}]})
 profile=await store.profileSnapshot('companion-1','weixin-1:user-1');m=profile.preferences[0]
 assert.equal(preferenceEvidenceCount(m),1);assert.equal(preferenceEmphasis(m),'');assert.notEqual(profile.version,version)
 assert.equal(m.evidence.filter(e=>e.supportsCurrent===false).length,3)
 await store.consolidate(turn('late-review',6000),{daily,memories:[{...repeat,sourceEvidence:{turnId:'two',at:2000,excerpt:'再次强调参考图要实际输入'}}]})
 const current=await store.profileSnapshot('companion-1','weixin-1:user-1')
 assert.equal(current.preferences[0].content,'仅用户明确要求时使用参考图。')
 assert.equal((await store.profileSnapshot('companion-1','other')).preferences.length,0)
 assert.equal(renderTaskPreferences({preferences:[]}), '')
})


test('task relevant preferences survive a full general baseline and reject foreign or unreliable entries',async()=>{
 const {renderTaskPreferences}=await import('../lib/execution/task-preferences.js')
 const base={kind:'preference',status:'active',companionId:'c',scopeId:'s',confidence:.96,importance:.85,evidence:[{turnId:'x',excerpt:'用户原话'}]}
 const profile={companionId:'c',scopeId:'s',preferences:Array.from({length:4},(_,i)=>({...base,id:'base'+i,subject:'通用偏好'+i,content:'通用'}))}
 const relevant={...base,id:'ref',subject:'参考图',content:'必须实际传入参考图'}
 const text=renderTaskPreferences(profile,[{...relevant,id:'foreign',scopeId:'other',content:'FOREIGN'},{...relevant,id:'weak',confidence:.1,content:'WEAK'},relevant])
 assert.match(text,/实际传入参考图/);assert.doesNotMatch(text,/FOREIGN|WEAK/)
 assert.equal(JSON.parse(text.split('：\n')[1]).length,4)
})
