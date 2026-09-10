import test from 'node:test'
import assert from 'node:assert/strict'
import { parseObservationStatuses } from '../lib/observation-executor.js'

test('completed and blocked checks are distinct; missing or duplicate outcomes are rejected', () => {
  const ids=new Set(['a','b'])
  const result=parseObservationStatuses(JSON.stringify({observations:[{concernId:'a',checkStatus:'completed'},{concernId:'b',checkStatus:'blocked'}]}),ids)
  assert.deepEqual([...result.completed],['a']);assert.deepEqual(result.blocked,['b'])
  for(const observations of [[],[{concernId:'a',changed:false}],[{concernId:'a',checkStatus:'completed'},{concernId:'a',checkStatus:'completed'}]]) {
    assert.throws(()=>parseObservationStatuses(JSON.stringify({observations}),new Set(['a'])),/状态/)
  }
})
