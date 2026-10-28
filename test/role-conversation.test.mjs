import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyCharacterCard, normalizeCharacterCard, roleTextForCard, renderCharacterCore } from '../lib/character/domain.js'
import { renderPartnerPersona } from '../lib/execution/agent-support.js'
import { renderConversationBehavior, renderConversationTurn } from '../lib/character/conversation-behavior.js'
import { createDefaultCompanion, normalizeCompanionDraft } from '../lib/domain.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

test('a short role needs no biography, motivation, examples or world setup', () => {
  const card = normalizeCharacterCard({ enabled: true, roleText: '- 说话坦率。\n- 被夸会嘴硬，正事认真。' })
  assert.equal(card.examples.length, 0)
  assert.equal(card.motivation, '')
  assert.equal(card.lore.length, 0)
  assert.equal(roleTextForCard(card), '- 说话坦率。\n- 被夸会嘴硬，正事认真。')
  assert.throws(() => normalizeCharacterCard({ ...card, roleText: '  ' }), /角色设定/)
  assert.throws(() => normalizeCharacterCard({ ...card, roleText: 123 }), /角色设定/)
  assert.throws(() => normalizeCharacterCard({ ...card, chatStyle: 'a'.repeat(2001) }), /聊天偏好/)
})

test('legacy conversion retains every role field and example once, without mutating stored content', () => {
  const card = { ...emptyCharacterCard(), enabled: true, identity: '旅人', motivation: '好奇', voice: '直说', relationship: '旧相识', greeting: '又见面了', examples: [{ user: '在吗', assistant: '刚到', avoid: '您好很高兴为您服务' }] }
  const before = JSON.stringify(card)
  const roleText = roleTextForCard(card)
  for (const value of ['旅人','好奇','直说','旧相识','又见面了','在吗','刚到','您好很高兴为您服务']) assert.ok(roleText.includes(value))
  assert.equal(JSON.stringify(card), before)
  const converted = normalizeCharacterCard({ ...card, roleText })
  assert.equal(roleTextForCard(converted), roleText)
  const changed = { ...converted, roleText: '新的角色，不喜欢寒暄' }
  const prompt = renderCharacterCore(changed)
  assert.ok(prompt.includes(changed.roleText))
  for (const value of ['旅人','旧相识','刚到','您好很高兴为您服务']) assert.ok(!prompt.includes(value))
  assert.throws(() => normalizeCharacterCard({ ...changed, roleText: '' }), /角色设定/, 'explicit clearing must not revive legacy fields')
})

test('role and chat preferences survive companion serialization without reducing capabilities', () => {
  const old = createDefaultCompanion()
  const input = { ...old, capabilities: ['skills','mcp','companions','schedules'], characterCard: { ...emptyCharacterCard(), enabled: true, roleText: '坦率的同行者', chatStyle: '玩笑直接接，认真问题认真答' } }
  const saved = { ...old, ...normalizeCompanionDraft(JSON.parse(JSON.stringify(input))) }
  assert.equal(saved.characterCard.roleText, input.characterCard.roleText)
  assert.equal(saved.characterCard.chatStyle, input.characterCard.chatStyle)
  assert.deepEqual(saved.capabilities, input.capabilities)
  const prompt = renderPartnerPersona(saved, 'conversation')
  assert.match(prompt, /工具与工作能力保持完整/)
  assert.match(prompt, /玩笑直接接/)
  for (const surface of ['heartbeat','ephemeral']) assert.doesNotMatch(renderPartnerPersona(saved, surface), /自然聊天行为|本轮聊天提醒/)
  assert.doesNotMatch(renderPartnerPersona({...saved,characterCard:{...saved.characterCard,enabled:false}}), /自然聊天行为|坦率的同行者/)
})

test('turn guidance works without a memory service, combines consecutive messages and updates in place', async () => {
  const companion = { ...createDefaultCompanion(), characterCard: normalizeCharacterCard({ enabled: true, roleText: '自然坦率' }) }
  companion.automation.memory.enabled = false
  const session = Session.create('role-no-memory')
  for (const text of ['今天很烦', '只是想吐槽']) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {surfaceOp:'append'})
  const sections = new Map()
  const agent = { session, ctx: { systemPrompt: { section: value => { sections.set(value.name,value); return () => sections.delete(value.name) } } } }
  const runtime = Object.create(PartnerAgentRuntime.prototype)
  const config = { companion, route: { kind:'local', sessionId: session.id, companionId:companion.id, userId:'local', channelId:'local:'+companion.id }, revision:'1' }
  Object.assign(runtime, { configurations: { forSession: () => config }, store: { snapshot: () => ({sessions:[config.route]}) }, contextRevisions:new WeakMap(), characterContexts:new Map() })
  const signal = new AbortController().signal
  assert.equal(await runtime.prepareConversationContext(agent,signal),true)
  assert.equal(sections.size,1)
  assert.match([...sections.values()][0].text,/连续发了 2 条/)
  assert.match([...sections.values()][0].text,/全部已授权工具/)
  assert.equal(await runtime.prepareConversationContext(agent,signal),false)
  config.companion = {...companion,characterCard:{...companion.characterCard,enabled:false}}
  config.revision = '2'
  await runtime.prepareConversationContext(agent,signal)
  assert.equal(sections.size,0)
  assert.equal(session.snapshotEvents().length,2,'guidance must not rewrite stored session history')
})

test('chat behavior never asks for a transport tool or synthetic wait', () => {
  const text = renderConversationBehavior(normalizeCharacterCard({enabled:true,roleText:'随和',length:'short'}))
  assert.match(text,/不凑满一至三句/)
  assert.match(text,/不要逐词拆句或人为延迟/)
  assert.match(text,/私聊明确找你时必须有可见回复/)
  assert.equal(renderConversationTurn(undefined,2),'')
})
