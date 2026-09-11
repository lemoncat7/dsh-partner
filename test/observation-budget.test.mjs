import test from 'node:test'
import assert from 'node:assert/strict'
import {observationBudget, observationFinalInstruction} from '../lib/observation-budget.js'

test('each concern gets twelve check rounds and an independent final round', () => {
  assert.equal(observationBudget(0).checking, true)
  assert.equal(observationBudget(11).checking, true)
  assert.equal(observationBudget(12).checking, false)
  assert.equal(observationBudget(13).checking, false)
  assert.match(observationFinalInstruction, /blocked/)
  assert.match(observationFinalInstruction, /未成功写入记录不得声称已记录/)
})
