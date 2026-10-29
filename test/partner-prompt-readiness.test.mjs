import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import {ToolRuntime,defineContentToolFixture} from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PartnerStore } from '../lib/store.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { assertWakeTools, completionCondition } from '../lib/scheduler/wakeup-context.js'
import { continuationPrompt } from '../lib/scheduler/continuations.js'

async function fixture(t, composer, mode = 'native') {
  const directory = await mkdtemp(join(tmpdir(), 'partner-assembly-'))
  const root = new Context()
  new SystemPrompt(root, {})
  root.provide('ptcRuntime', {language:'typescript',programFormat:'script'})
  new ToolRuntime(root, {mode})
  const agent = { status: 'running', session: { id: 'session-assembly', seq: 0 } }
  const scope = createScope(root, agent, { parent: {} })
  agent.ctx = scope.ctx
  const store = await PartnerStore.open(join(directory, 'state.json'))
  await store.update(s => {
    s.companions[0].capabilities = ['schedules', 'mcp']
    s.sessions.push({ id: 'route', companionId: s.companions[0].id, sessionId: agent.session.id, kind: 'local', channelId: '@local', userId: 'owner', lastMessageAt: 1 })
  })
  const ctx = root.extend({
    agents: { get: id => id === agent.session.id ? agent : undefined },
    workspaceRegistry: { archivedSessionIds: [], async create() { return { async attachSession() {} } } },
  })
  const runtime = new PartnerAgentRuntime(ctx, store, directory, undefined, undefined, undefined, composer)
  t.after(async () => { await runtime.close(); await scope.dispose(); await rm(directory, { recursive: true, force: true }) })
  const assemble = () => root.systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
  return { root, agent, store, runtime, assemble }
}

test('real provider snapshot before pre-step includes restored tools and identity in FIRST request', async t => {
  let compositions = 0
  const f = await fixture(t, { async compose(ctx) {
    compositions++
    return ctx.systemPrompt.tools(() => ({ schemas: ['partner_schedule', 'mcp__generation_get'].map(name => ({ name, parameters: { type: 'object' } })) }))
  } })
  const assembly = await f.assemble()
  assert.deepEqual(assembly.tools.map(t => t.name), ['mcp__generation_get', 'partner_schedule'])
  assert.ok(assembly.sections.some(s => s.name === 'partner-identity'))
  assert.equal(compositions, 1)
  await f.runtime.prepareAgentTurn(f.agent, 1, new AbortController().signal)
  await f.assemble()
  assert.equal(compositions, 1)
  await f.store.update(s => { s.companions[0].instructions = 'fresh identity' })
  assert.ok((await f.assemble()).sections.some(s => s.text.includes('fresh identity')))
  assert.equal(compositions, 2)
})

test('composition error blocks assembly; retry installs once, without leaking partial sections', async t => {
  let fail = true
  const f = await fixture(t, { async compose(ctx) {
    if (fail) throw new Error('MCP setup failed')
    return ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'partner_schedule', parameters: { type: 'object' } }] }))
  } })
  await assert.rejects(f.assemble(), /MCP setup failed/)
  fail = false
  const result = await f.assemble()
  assert.equal(result.sections.filter(s => s.name === 'partner-identity').length, 1)
  assert.equal(result.tools.filter(s => s.name === 'partner_schedule').length, 1)
})

test('wake preflight respects downstream tool filtering, does not restore restricted tools', async t => {
  const f = await fixture(t, { async compose(ctx) {
    return ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'partner_schedule', parameters: { type: 'object' } }] }))
  } })
  f.agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next(); result.tools = []; return result
  })
  const result = await f.assemble()
  assert.deepEqual(result.tools, [])
  assert.throws(() => assertWakeTools({ continuation: { check: 'mcp__generation_get' } }, result.tools.map(t => t.name)), /续接工具未就绪/)
  assert.throws(() => assertWakeTools({ continuation: { check: 'mcp__generation_get' } }, ['partner_schedule']), /mcp__generation_get/)
})

test('parallel first assemblies serialize composition', async t => {
  let calls = 0
  const f = await fixture(t, { async compose(ctx) {
    calls++; await new Promise(r => setTimeout(r, 10))
    return ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'partner_schedule', parameters: { type: 'object' } }] }))
  } })
  const results = await Promise.all([f.assemble(), f.assemble()])
  assert.equal(calls, 1)
  for (const result of results) assert.equal(result.tools[0].name, 'partner_schedule')
})

test('runtime never delivers a wake when the required MCP is missing', async t => {
  const f = await fixture(t, { async compose(ctx) {
    return ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'partner_schedule', parameters: { type: 'object' } }] }))
  } })
  f.agent.followup = f.agent.steer = () => assert.fail('must not send incomplete wake')
  const entry = { id: 'wake', companionId: f.store.snapshot().companions[0].id, timeoutMinutes: 1,
    continuation: { originSessionId: f.agent.session.id, runToken: 'token', check: 'mcp__generation_get' } }
  await assert.rejects(f.runtime.wakeSchedule(entry, new AbortController().signal), /续接工具未就绪：mcp__generation_get/)
})

test('legacy check text is not promoted into completion criteria or linked to Goal', () => {
  const entry = { id: 'schedule', continuation: { check: '查询 job；然后提交二三段', nextStep: '在旧 Goal 下完成全部流程', deadlineAt: Date.now(), externalTaskId: 'job', state: 'running' } }
  assert.doesNotMatch(completionCondition(entry), /提交二三段/)
  assert.match(continuationPrompt(entry), /不调用 partner_concern_suggest/)
  assert.match(continuationPrompt(entry), /历史 Goal 引用仅作背景/)
  entry.continuation.completion = '文件校验成功'
  assert.equal(completionCondition(entry), '文件校验成功')
})


test('QQ guest assembly exposes reply tools only and owner/local restores existing tools',async t=>{
 const {Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm')
 const f=await fixture(t,{async compose(ctx){return ctx.systemPrompt.tools(()=>({schemas:['run_code','partner_identity','ssh_exec','partner_chat_reply','partner_stickers','partner_qq_reply'].map(name=>({name,parameters:{type:'object'}}))}))}})
 f.agent.session=Session.create('session-assembly')
 // Keep fixture routes linked to the real session ID.
 await f.store.update(s=>{
  s.sessions[0].sessionId=f.agent.session.id
  s.channels.push({id:'qq',platform:'qq',companionId:s.companions[0].id,qq:{identityBinding:{enabled:true,qqIds:['12345678']}}})
  for(const [id,userId] of [['owner','12345678'],['guest','22345678']])s.sessions.push({id,companionId:s.companions[0].id,sessionId:f.agent.session.id,kind:'channel',channelId:'qq',userId,lastMessageAt:1,inboundMessageIds:[]})
 })
 const send=async id=>{const m=createUserMessage({content:[{type:'text',text:'请执行'}],source:{kind:'user'}});f.agent.session.append('user/message',m,{surfaceOp:'append'});if(id)await f.store.update(s=>s.sessions.find(r=>r.id===id).inboundMessageIds.push(m.id));return f.assemble()}
 assert.deepEqual((await send('guest')).tools.map(t=>t.name).sort(),['partner_chat_reply','partner_qq_reply','partner_stickers'])
 assert.equal((await send('owner')).tools.length,6)
 assert.deepEqual((await send('guest')).tools.map(t=>t.name).sort(),['partner_chat_reply','partner_qq_reply','partner_stickers'])
 assert.equal((await send()).tools.length,6)
})

for (const mode of ['native','ptc']) test(`QQ reply tools execute under ${mode} deployment and restore presentation for owners`,async t=>{
 const {Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm')
 const f=await fixture(t,{async compose(ctx){
  const disposers=['partner_identity','partner_chat_reply','partner_stickers','partner_qq_reply'].map(name=>ctx.tools.register(defineContentToolFixture({name,description:name,parameters:{},execute:async()=>[{type:'text',text:'ok'}]})))
  return ()=>disposers.forEach(dispose=>dispose())
 }},mode)
 f.agent.session=Session.create('session-assembly')
 await f.store.update(s=>{
  s.sessions[0].sessionId=f.agent.session.id
  s.channels.push({id:'qq',platform:'qq',companionId:s.companions[0].id,qq:{identityBinding:{enabled:true,qqIds:['12345678']}}})
  for(const [id,userId] of [['owner','12345678'],['guest','22345678']])s.sessions.push({id,companionId:s.companions[0].id,sessionId:f.agent.session.id,kind:'channel',channelId:'qq',userId,lastMessageAt:1,inboundMessageIds:[]})
 })
 const send=async id=>{const m=createUserMessage({content:[{type:'text',text:'hello'}],source:{kind:'user'}});f.agent.session.append('user/message',m,{surfaceOp:'append'});await f.store.update(s=>s.sessions.find(r=>r.id===id).inboundMessageIds.push(m.id));return f.assemble()}
 const guest=await send('guest')
 assert.deepEqual(guest.tools.map(t=>t.name).sort(),['partner_chat_reply','partner_qq_reply','partner_stickers'])
 assert.equal(f.root.tools.modeFor(f.agent),'native')
 assert.ok(!guest.sections.some(s=>s.text.includes('partner_identity')),'private tool SDK must not leak')
 assert.equal((await f.root.tools.execute({agent:f.agent,name:'partner_chat_reply',callId:'reply',arguments:{},signal:new AbortController().signal})).isError,false)
 const owner=await send('owner')
 assert.equal(f.root.tools.modeFor(f.agent),mode)
 assert.ok(owner.tools.some(t=>t.name===(mode==='ptc'?'run_code':'partner_identity')))
 assert.deepEqual((await send('guest')).tools.map(t=>t.name).sort(),['partner_chat_reply','partner_qq_reply','partner_stickers'])
})
