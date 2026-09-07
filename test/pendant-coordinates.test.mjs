import assert from 'node:assert/strict'
import test from 'node:test'
import { measureFixedLayerOrigin } from '../lib/pendant/coordinates.js'

function layer(origin, transform = 'translate3d(150px, 220px, 0)', priority = '') {
  const state = { transform, priority, reads: 0 }
  return { state, style: {
    getPropertyValue: () => state.transform,
    getPropertyPriority: () => state.priority,
    setProperty: (_name, value, priority) => { state.transform = value; state.priority = priority },
    removeProperty: () => { state.transform = ''; state.priority = '' },
  }, getBoundingClientRect() {
    state.reads++
    assert.equal(state.transform, 'none', 'measure without the previous render translation')
    return origin
  } }
}

test('fixed-layer measurement distinguishes viewport and offset containing blocks without accumulating transforms', () => {
  for (const origin of [{ left: 0, top: 0 }, { left: 128, top: 48 }, { left: -24.5, top: 37.25 }]) {
    const element = layer(origin)
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(measureFixedLayerOrigin(element), origin)
      assert.equal(element.state.transform, 'translate3d(150px, 220px, 0)')
    }
    assert.equal(element.state.reads, 3)
  }
})

test('measurement preserves inline priority, an absent declaration and restores on failure', () => {
  for (const transform of ['', 'translate(22px, 9px)']) {
    const element = layer({ left: 10, top: 20 }, transform, transform ? 'important' : '')
    const original = { ...element.state }
    measureFixedLayerOrigin(element)
    assert.equal(element.state.transform, original.transform)
    assert.equal(element.state.priority, original.priority)
    element.getBoundingClientRect = () => { throw new Error('detached') }
    assert.throws(() => measureFixedLayerOrigin(element), /detached/)
    assert.equal(element.state.transform, original.transform)
    assert.equal(element.state.priority, original.priority)
  }
})
