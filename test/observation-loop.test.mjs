import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { executeObservationLoop } from '../lib/observation-loop.js'

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
