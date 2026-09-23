import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { PartnerStore } from '../lib/store.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { assertWakeTools, completionCondition } from '../lib/scheduler/wakeup-context.js'
import { continuationPrompt } from '../lib/scheduler/continuations.js'

async function fixture(t, composer) {
  const directory = await mkdtemp(join(tmpdir(), 'partner-assembly-'))
  const root = new Context()
  new SystemPrompt(root, {})
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
