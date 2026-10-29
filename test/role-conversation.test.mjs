import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyCharacterCard, normalizeCharacterCard, roleTextForCard, renderCharacterCore } from '../lib/character/domain.js'
import {relationshipTextForIdentity} from '../lib/character/relationship-adapter.js'
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
  for (const value of ['旅人','好奇','直说','又见面了','在吗','刚到','您好很高兴为您服务']) assert.ok(roleText.includes(value))
  assert.ok(!roleText.includes('旧相识'))
  assert.equal(relationshipTextForIdentity({characterCard:card}),'旧相识')
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
  const agent = { session, ctx: { systemPrompt: { context: value => { sections.set(value.name,value); return () => sections.delete(value.name) } } } }
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


test('segmentation permits multiple messages without encouraging a second reply at each turn', () => {
  const card=normalizeCharacterCard({enabled:true,roleText:'坦率的同行者',length:'short',segmentedReplies:true,stickersEnabled:true})
  const behavior=renderConversationBehavior(card),turn=renderConversationTurn(card,1)
  assert.match(behavior,/普通闲聊通常只发一句短话/)
  for(const prompt of [behavior,turn]) {
    assert.match(prompt,/分段回复已开启/)
    assert.match(prompt,/允许分段，不是要求多发/)
    assert.doesNotMatch(prompt,/优先分成两条|有前后两个接话点时分别发两条/)
    assert.match(prompt,/表情包已开启/)
    assert.match(prompt,/partner_chat_reply/)
    assert.match(prompt,/不每轮固定发/)
  }
  assert.doesNotMatch(renderConversationTurn({...card,enabled:false},1),/partner_chat_reply/)
  assert.match(renderConversationTurn({...card,segmentedReplies:false},1),/文字只用一条/)
  assert.match(renderConversationTurn({...card,stickersEnabled:false},1),/不查找或提交表情/)
  assert.doesNotMatch(renderConversationTurn({...card,stickersEnabled:false,segmentedReplies:false},1),/partner_chat_reply/)
})


test('tool discovery never changes the full persona or drops dialogue examples',()=>{
 const companion={...createDefaultCompanion(),characterCard:normalizeCharacterCard({enabled:true,roleText:'## 你是谁\n坦率的同行者。\n\n## 对话参考\n对方：下雨了。\n回应：那今天就赖着。',chatStyle:'接话直接，不机械追问'})}
 const regular=renderPartnerPersona({...companion,toolDiscovery:false},'conversation')
 const discovered=renderPartnerPersona({...companion,toolDiscovery:true},'conversation')
 assert.equal(discovered,regular);assert.ok(discovered.includes(companion.characterCard.roleText));assert.match(discovered,/接话直接/)
 const turn=renderConversationTurn(companion.characterCard,1)
 assert.match(turn,/你仍是同一个角色/);assert.match(turn,/不复述自己的错误句子/)
 const activity=renderConversationTurn(companion.characterCard,1,true)
 assert.match(activity,/partner_activity_finish/);assert.doesNotMatch(activity,/直接私聊需要可见回复/)
})
