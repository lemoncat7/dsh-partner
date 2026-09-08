import test from 'node:test'
import assert from 'node:assert/strict'
import RAPIER from '@dimforge/rapier3d-compat'
import { createLanyardPhysics } from '../lib/pendant/physics.js'
import { settleCardFacing } from '../lib/pendant/facing.js'
await RAPIER.init()

test('idle side-on cards settle front; unread cards settle back and can return after reading', () => {
  for (const yaw of [Math.PI / 2, -Math.PI / 2, Math.PI, 0]) {
    const { world, badge } = createLanyardPhysics()
    try {
      for (let i = 0; i < 600; i++) world.step()
      badge.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
      for (const back of [false, true, false]) {
        for (let i = 0; i < 1800; i++) { settleCardFacing(badge, back, false); world.step() }
        const q = badge.rotation(), facing = 1 - 2 * (q.x ** 2 + q.y ** 2)
        assert.ok(back ? facing < -.99 : facing > .99, `${yaw}, back=${back}, facing=${facing}`)
        assert.equal(settleCardFacing(badge, back, false), false, 'rest does not keep renderer awake')
      }
    } finally { world.free() }
  }
})
test('orientation assist never takes control while dragging or throwing', () => {
  const { world, badge } = createLanyardPhysics()
  try {
    badge.setAngvel({ x: 0, y: 5, z: 0 }, true)
    assert.equal(settleCardFacing(badge, true, false), false)
    assert.equal(badge.angvel().y, 5)
    badge.setAngvel({ x: 0, y: .1, z: 0 }, true)
    assert.equal(settleCardFacing(badge, true, true), false)
    assert.ok(Math.abs(badge.angvel().y - .1) < .00001)
  } finally { world.free() }
})
test('a readable face may retain a natural hanging roll without waking the renderer', () => {
  const { world, badge } = createLanyardPhysics()
  try {
    badge.setRotation({ x: 0, y: 0, z: Math.sin(.2), w: Math.cos(.2) }, true)
    assert.equal(settleCardFacing(badge, false, false), false)
    assert.equal(badge.angvel().z, 0)
  } finally { world.free() }
})
