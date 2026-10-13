import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { executeObservationLoop, observationToolNames } from '../lib/observation-loop.js'

test('observation inherits session plugin capabilities without granting absent tools', () => {
  const names = observationToolNames(['read', 'ssh_exec', 'custom_authorized_lookup', 'write', 'edit', 'str_replace_editor'].map(name => ({name})), false, false)
  assert.deepEqual([...names], ['read', 'ssh_exec', 'custom_authorized_lookup'])
  assert.equal(names.has('unavailable_tool'), false)
})

test('recording retries retain their narrow target-only capability set', () => {
  const inherited = ['read', 'ssh_exec', 'custom_lookup', 'write', 'edit'].map(name => ({name}))
  assert.deepEqual([...observationToolNames(inherited, true, false)], ['read'])
  assert.deepEqual([...observationToolNames(inherited, true, true)], ['read', 'write', 'edit'])
})

test('inherited plugin execution retains parent authorization guards', async () => {
  const ctx = new Context()
  ctx.provide('systemPrompt', {tools: () => () => {}})
  new ToolRuntime(ctx)
  const source = createScope(ctx, {})
  const agent = {session: {header: {}}, options: {}}
  const child = createScope(ctx, agent, {parent: (await import('@deepseek-ai/dsh-scope')).scopeOf(source.ctx)})
  agent.ctx = child.ctx
  let calls = 0
  source.ctx.tools.register(defineContentToolFixture({
    name: 'custom_authorized_lookup', description: 'test lookup', parameters: {},
    execute: async () => { calls++; return [{type: 'text', text: 'ok'}] },
  }))
  try {
    assert.equal(observationToolNames(ctx.tools.schemas(agent), false, false).has('custom_authorized_lookup'), true)
    const invoke = () => ctx.tools.execute({callId: 'test', name: 'custom_authorized_lookup', arguments: {}, agent, signal: new AbortController().signal})
    assert.equal((await invoke()).isError, false)
    source.ctx.tools.guard(() => 'source authorization denied')
    assert.equal((await invoke()).isError, true)
    assert.equal(calls, 1)
  } finally { await child.dispose(); await source.dispose() }
})

test('lightweight observation fails closed without inherited tool scope', async () => {
  const result = await executeObservationLoop({ ctx: {}, conversation: { ctx: new Context() }, companion: {}, concerns: [], guard: () => {}, parse: () => assert.fail('must not parse an unchecked observation') })
  assert.match(result.error, /继承/)
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.tools, [])
})

test('lightweight runner retains bounded private messages and native tool execution', async () => {
  const source = await readFile(new URL('../src/observation-loop.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /executor\.execute|agents\.create|session\.append|tools\.restrict\(/)
  assert.match(source, /ctx\.tools\.execute/)
  assert.doesNotMatch(source, /calls >= 24|stageRemainingMs|150_000/)
  assert.match(source, /AbortSignal\.timeout\(OBSERVATION_MODEL_TIMEOUT_MS\)/)
  assert.match(source, /await scope\.dispose\(\)/)
  assert.match(source, /recordTarget\?\.kind === 'note'/)
  assert.match(source, /signal: modelSignal/)
  assert.match(source, /open && modelSignal\.aborted/)
  assert.match(source, /finalizing = true; continue/)
  assert.match(source, /!open && pending\.length/)
  assert.match(source, /modelMs: Date\.now\(\) - modelAt/)
})
