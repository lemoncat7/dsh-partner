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
test('document setup has a separate bounded allowance, never unlimited rounds',()=>{
  assert.equal(observationBudget(12,4).checking,true)
  assert.equal(observationBudget(16,4).checking,false)
  assert.equal(observationBudget(19,8).checking,true)
  assert.equal(observationBudget(20,8).checking,false)
  assert.equal(observationBudget(20,999).checking,false)
  assert.equal(observationBudget(12,-10).checking,false)
})
