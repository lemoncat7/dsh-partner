import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { registerPartnerApi } from '../lib/api.js'
import { effectiveIdentity, pageIdentity, applyIdentity } from '../lib/companions/identity.js'
import { identityTool } from '../lib/companions/identity-tool.js'
import { CompanionManagementService } from '../lib/companions/management.js'
import { SessionConfigurationIndex } from '../lib/companions/session-configuration.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'partner-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json'), store = await PartnerStore.open(path)
  const id = store.snapshot().companions[0].id
  await store.update(state => {
    state.companions.push({ ...structuredClone(state.companions[0]), id: 'manager', name: '管理', capabilities: ['administration'] })
    state.sessions.push({ id: 'local', kind: 'local', companionId: id, sessionId: 'session', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
    state.sessions.push({ id: 'other', kind: 'local', companionId: 'manager', sessionId: 'foreign', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
  })
  const tool = identityTool(id, store), exec = { agent: { session: { id: 'session' } }, signal: new AbortController().signal }
  const call = async args => JSON.parse(await tool.execute(args, exec))
  const inspect = () => call({ action: 'inspect' })
  const update = async patch => call({ action: 'update', expectedAt: (await inspect()).expectedAt, patch })
  return { store, path, id, tool, exec, call, inspect, update }
}

test('AI generates and revises a complete effective persona, preserving legacy human draft across restart', async t => {
  const f = await fixture(t), original = effectiveIdentity(f.store.snapshot().companions[0])
  const index = new SessionConfigurationIndex(f.store); t.after(() => index.close())
  const revision = index.forSession('session').revision
  const result = await f.update({ name: '小林', role: '直率的朋友', description: '自然相处', instructions: '按用户需要使用工具', characterCard: {
    enabled: true, roleText: '嘴硬心软，先接话再解释。偶尔吐槽，难过时认真听。', chatStyle: '自然短句', segmentedReplies: true, stickersEnabled: true,
    length: 'short', narration: false, examples: [{ user: '回来了', assistant: '这么晚。给你留了点吃的。' }],
    lore: [{ id: 'home', title: '住处', keywords: ['家'], content: '虚构的温暖小屋', enabled: true }],
  }, idleContact: { enabled: true, routeId: 'local' }, sleepPolicy: {enabled:true,dreamsEnabled:true} })
  assert.equal(result.applied, true)
  assert.equal(result.humanDraftPreserved, true)
  let current = f.store.snapshot().companions[0]
  assert.deepEqual(pageIdentity(current), original)
  assert.equal(current.characterCard.enabled, true)
  assert.equal(current.sleepPolicy.enabled, true)
  assert.equal(current.idleContact.dailyLimit, undefined)
  assert.notEqual(index.forSession('session').revision, revision)
  await f.update({ characterCard: { chatStyle: '偶尔调侃', lore: [] }, sleepPolicy: { dreamsEnabled: false } })
  current = f.store.snapshot().companions[0]
  assert.equal(current.characterCard.roleText, result.identity.characterCard.roleText)
  assert.equal(current.characterCard.stickersEnabled, true)
  assert.deepEqual(current.characterCard.lore, [])
  assert.equal(current.idleContact.routeId, 'local')
  assert.deepEqual(pageIdentity(current), original)
  const reopened = (await PartnerStore.open(f.path)).snapshot().companions[0]
  assert.deepEqual(reopened, current)
  assert.deepEqual((await f.inspect()).routes.map(r => r.id), ['local'])
  assert.equal('identityDraft' in await f.inspect(), false)
})

test('human save fully replaces effective identity and draft without restoring omitted AI card fields', async t => {
  const f = await fixture(t)
  await f.update({ characterCard: { enabled: true, roleText: 'AI 的版本', stickersEnabled: true } })
  const current = f.store.snapshot().companions[0]
  const human = { ...pageIdentity(current), characterCard: { enabled: true, identity: '人工旧格式角色', voice: '轻快' } }
  await f.store.update(state => applyIdentity(state, state.companions[0], human, current.updatedAt, 'page'))
  const saved = f.store.snapshot().companions[0]
  assert.deepEqual(saved.identityDraft, effectiveIdentity(saved))
  assert.equal(saved.characterCard.roleText, undefined)
  assert.equal(saved.characterCard.stickersEnabled, undefined)
  assert.equal(saved.characterCard.identity, '人工旧格式角色')
  const draft = structuredClone(saved.identityDraft)
  await f.update({ characterCard: null, idleContact: null })
  assert.equal(f.store.snapshot().companions[0].characterCard, undefined)
  assert.deepEqual(f.store.snapshot().companions[0].identityDraft, draft)
})

test('stale or simultaneous updates cannot silently overwrite newer changes; cancelled and invalid edits are atomic', async t => {
  const f = await fixture(t), expectedAt = (await f.inspect()).expectedAt
  const results = await Promise.allSettled(['one', 'two'].map(name => f.call({ action: 'update', expectedAt, patch: { name } })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const before = f.store.snapshot()
  await assert.rejects(f.call({ action: 'update', expectedAt, patch: { name: 'stale' } }), /身份已变化/)
  for (const patch of [{ identityDraft: {} }, { capabilities: ['administration'] }, { model: 'other' }, { characterCard: { enabled: true } }, { idleContact: { enabled: true, routeId: 'other' } }, { name: '' }]) await assert.rejects(f.update(patch))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.tool.execute({ action: 'update', expectedAt: before.companions[0].updatedAt, patch: { name: 'cancelled' } }, { ...f.exec, signal: abort.signal }))
  await assert.rejects(f.tool.execute({ action: 'inspect' }, { ...f.exec, agent: { session: { id: 'foreign' } } }), /跨伙伴/)
  await assert.rejects(f.tool.execute({ action: 'inspect' }, { signal: f.exec.signal }), /伙伴会话/)
  assert.deepEqual(f.store.snapshot(), before)
})

test('page identity API saves both copies and unrelated settings endpoint preserves draft', async t => {
  const f = await fixture(t)
  let handler
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/api', { store: f.store })
  const put = async (body, suffix = '/identity', headers = { 'x-dsh-partner-request': '1' }) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'PUT', url: `/api/companions/${f.id}${suffix}`, headers })
    const res = { statusCode: 0, setHeader() {}, end(data) { this.body = data ? JSON.parse(data) : undefined } }
    await handler(req, res); return res
  }
  await f.update({ characterCard: { enabled: true, roleText: 'AI 生成人格' } })
  let current = f.store.snapshot().companions[0]
  const identity = { ...pageIdentity(current), name: '页面原稿' }
  const body = { identity, expectedAt: current.updatedAt }
  assert.equal((await put(body, '/identity', {})).statusCode, 403)
  assert.equal((await put(body)).statusCode, 200)
  current = f.store.snapshot().companions[0]
  assert.equal(current.characterCard, undefined)
  assert.deepEqual(current.identityDraft, effectiveIdentity(current))
  assert.notEqual((await put(body)).statusCode, 200)
  await f.update({ name: 'AI 新名字' })
  current = f.store.snapshot().companions[0]
  assert.equal((await put({ companion: { ...current, capabilities: ['skills'] } }, '')).statusCode, 200)
  assert.equal(f.store.snapshot().companions[0].identityDraft.name, '页面原稿')
  assert.equal(f.store.snapshot().companions[0].name, 'AI 新名字')
  assert.deepEqual(f.store.snapshot().companions[0].capabilities, ['skills'])
})

test('privileged management can generate another persona while preserving its human draft', async t => {
  const f = await fixture(t), original = pageIdentity(f.store.snapshot().companions[0])
  const management = new CompanionManagementService(f.store, { isBusy: () => false, catalog: async () => ({}), reload: async () => {} })
  let before = management.inspect('manager', f.id)
  await management.update('manager', f.id, before.revision, { characterCard: { enabled: true, roleText: '管理伙伴生成的人格' } })
  assert.deepEqual(f.store.snapshot().companions[0].identityDraft, original)
  before = management.inspect('manager', f.id)
  assert.equal(before.characterCard.roleText, '管理伙伴生成的人格')
  await management.update('manager', f.id, before.revision, { characterCard: { chatStyle: '自然简短' } })
  assert.equal(f.store.snapshot().companions[0].characterCard.roleText, before.characterCard.roleText)
  before = management.inspect('manager', f.id)
  await management.update('manager', f.id, before.revision, { characterCard: null })
  assert.equal(f.store.snapshot().companions[0].characterCard, undefined)
  assert.deepEqual(f.store.snapshot().companions[0].identityDraft, original)
})

test('identity discovery exposes an authoring format and applies generated role without touching the page draft',async t=>{
 const f=await fixture(t),before=pageIdentity(f.store.snapshot().companions[0]),inspection=await f.inspect()
 for(const section of ['你是谁','怎么相处','怎么说话','对话参考'])assert.ok(inspection.generationGuide.includes(section))
 await f.update({characterCard:{enabled:true,roleText:'## 你是谁\n爱观察的同行者。\n\n## 怎么相处\n坦率、不附和。\n\n## 对话参考\n对方：下雨了。\n回应：那今天就赖着。'}})
 assert.deepEqual(pageIdentity(f.store.snapshot().companions[0]),before)
})
