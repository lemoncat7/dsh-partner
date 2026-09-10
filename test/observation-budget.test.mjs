import test from 'node:test'
import assert from 'node:assert/strict'
import {observationBudget, observationFinalInstruction} from '../lib/observation-budget.js'

test('reserves a final response window independently of round and call limits', () => {
  assert.equal(observationBudget(149999, 5, 6).checking, true)
  assert.equal(observationBudget(150000, 5, 6).checking, false)
  assert.equal(observationBudget(180000, 0, 0).checkRemainingMs, 0)
  assert.equal(observationBudget(0, 12, 0).checking, false)
  assert.equal(observationBudget(0, 0, 24).checking, false)
  assert.match(observationFinalInstruction, /blocked/)
  assert.match(observationFinalInstruction, /未成功写入记录不得声称已记录/)
})
