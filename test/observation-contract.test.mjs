import test from 'node:test'
import assert from 'node:assert/strict'
import { observationRetryAt, observationCapabilityContext } from '../lib/observation-contract.js'
import { parseObservationStatuses } from '../lib/observation-executor.js'
import { validateObservationSources } from '../lib/observation-sources.js'

test('generic outcomes do not turn baseline or deduplication into new work', () => {
  const parse = row => parseObservationStatuses(JSON.stringify({observations:[{concernId:'a',...row}]}),new Set(['a']))
  for (const outcome of ['baseline_initialized','already_processed','unchanged']) {
    assert.equal(parse({checkStatus:'completed',changed:false,outcome}).outcomes.a,outcome)
    assert.throws(()=>parse({checkStatus:'completed',changed:true,outcome}),/矛盾/)
  }
  assert.throws(()=>parse({checkStatus:'blocked',changed:true,outcome:'changed'}),/矛盾/)
  const blocked=parse({checkStatus:'blocked',outcome:'blocked',failureKind:'rate_limited',retryAt:'2026-10-13T09:00:00Z'})
  assert.equal(blocked.failures.a.retryAt,Date.parse('2026-10-13T09:00:00Z'))
})
test('rate limit timing is bounded and does not accelerate permission retries', () => {
  const now=Date.now()
  assert.equal(observationRetryAt(now,360,{kind:'rate_limited',retryAt:now+120000}),now+120000)
  assert.equal(observationRetryAt(now,360,{kind:'rate_limited',retryAt:0}),now+60000)
  assert.equal(observationRetryAt(now,360,{kind:'authentication',retryAt:now}),now+21600000)
  assert.equal(observationRetryAt(now,360,{kind:'rate_limited',retryAt:Infinity}),now+21600000)
})
test('capability manifest explains missing tools without granting them', () => {
  const manifest=JSON.parse(observationCapabilityContext(['read'],['read','ssh_exec']))
  assert.deepEqual(manifest.availableTools,['read'])
  assert.deepEqual(manifest.unavailableInBackground,['ssh_exec'])
  assert.throws(()=>validateObservationSources([{name:'ssh_exec'}],new Set()),/无效/)
  assert.throws(()=>validateObservationSources([{name:'observation_read_test'},{name:'observation_read_test'}],new Set()),/重复/)
  assert.equal(validateObservationSources([{name:'observation_read_test'}],new Set()).length,1)
})
