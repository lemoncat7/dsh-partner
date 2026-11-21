import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundResult, PartnerBackgroundAgents } from '../lib/execution/background-agent.js'

const output = { text: '报告已完成', files: [] }
const turnStart = { type: 'turn/start' }
const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
const outputCall = { type: 'tool/call', data: { name: 'structured_output', callId: 'output', arguments: JSON.stringify(output) } }
const outputReceipt = { type: 'tool/result', data: { message: { toolCallId: 'output' } } }

test('background delivery reads a committed structured result from the latest completed turn', () => {
  const completed = [turnStart, outputCall, outputReceipt, turnEnd]
  assert.deepEqual(backgroundResult(completed), { stopReason: 'completed', structured: output })
  assert.deepEqual(backgroundResult([...completed, turnStart, outputCall, turnEnd]), { stopReason: 'completed' })
  assert.deepEqual(backgroundResult([...completed, turnStart, outputCall, outputReceipt]), { stopReason: 'error' })
})

test('background agents resume through the registry and validate the persisted parent before enqueueing', async () => {
  const parent = {
    id: 'parent',
    session: { header: { id: 'parent' }, requestHeader: () => undefined },
    options: { provider: 'default', model: 'main' },
    ctx: { get: () => undefined },
  }
  const pending = Promise.withResolvers()
  const registrations = new Map()
  const sessionEvents = [turnStart, turnEnd].map((event, seq) => ({ ...event, seq }))
  let input, disposed = 0
  const ctx = {
    get: () => undefined,
    tools: { register(tool) { registrations.set(tool.name, tool) } },
    systemPrompt: { context() {}, getContextOrder: () => 0 },
  }
  const child = {
    session: { header: { parentSession: 'another-parent' }, snapshotEvents: () => sessionEvents },
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) { input = message },
    whenIdle: () => pending.promise,
    status: 'idle',
  }
  ctx.agents = {
    get: id => id === parent.id ? parent : undefined,
    async resume({ resumeSessionId, setup }) {
      assert.equal(resumeSessionId, 'original-child')
      const prepared = await setup(ctx, child)
      prepared.commit()
      return { agent: child, async dispose() { disposed++ } }
    },
  }
  const agents = new PartnerBackgroundAgents(ctx)
  const spec = {
    childId: 'original-child', parent, cwd: '/tmp', label: '任务', signal: AbortSignal.timeout(1000),
    prompt: [{ type: 'text', text: '继续任务' }],
    authorize() {},
    outputSchema: { type: 'object', properties: { text: { type: 'string' }, files: { type: 'array', items: { type: 'object' } } }, required: ['text', 'files'] },
  }
  await assert.rejects(agents.resumeActivation(spec), /原会话不匹配/)
  assert.equal(input, undefined)

  child.session.header.parentSession = parent.id
  const resumed = await agents.resumeActivation(spec)
  assert.deepEqual(input.content, spec.prompt)
  assert.equal(resumed.childId, spec.childId)
  let concluded = false
  await registrations.get('structured_output').execute(output, { concludeTurn() { concluded = true } })
  assert.equal(concluded, true)
  sessionEvents.push(...[turnStart, outputCall, outputReceipt, turnEnd].map((event, index) => ({ ...event, seq: index + 2 })))
  pending.resolve()
  assert.deepEqual(await resumed.result, { stopReason: 'completed', structured: output })
  await resumed.dispose()
  assert.equal(disposed, 1)
})
