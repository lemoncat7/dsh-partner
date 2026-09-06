import assert from 'node:assert/strict'
import test from 'node:test'
import RAPIER from '@dimforge/rapier3d-compat'
import { createLanyardPhysics, LANYARD_STEP } from '../lib/pendant/physics.js'
import { createNoticeMotion } from '../lib/pendant/notice-motion.js'

await RAPIER.init()
test('notice gently brings front, inner and edge orientations to the art face before flashing', () => {
  for (const yaw of [0, Math.PI, -Math.PI / 2, 2.8]) {
    const { world, badge } = createLanyardPhysics()
    try {
      for (let i = 0; i < 480; i++) world.step()
      badge.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true)
      badge.setAngvel({ x: 0, y: 0, z: 0 }, true)
      const motion = createNoticeMotion(badge)
      motion.request()
      let flashes = 0, maxDistance = 0
      for (let i = 0; i < 360; i++) {
        if (motion.step(LANYARD_STEP, false)) {
          const q = badge.rotation()
          assert.ok(1 - 2 * (q.x ** 2 + q.y ** 2) > .99)
          flashes++
        }
        world.step()
        maxDistance = Math.max(maxDistance, Math.abs(badge.translation().x))
      }
      assert.equal(flashes, 1)
      assert.equal(motion.phase, 'idle')
      assert.ok(maxDistance > .01 && maxDistance < .35, 'small visible sway, not a large throw')
    } finally { world.free() }
  }
})

test('held and rapidly spinning cards defer notices; cancel leaves physical velocity untouched', () => {
  const { world, badge } = createLanyardPhysics()
  try {
    const motion = createNoticeMotion(badge)
    motion.request(); motion.request()
    assert.equal(motion.step(LANYARD_STEP, true), false)
    assert.equal(motion.phase, 'pending')
    badge.setAngvel({ x: 0, y: 8, z: 0 }, true)
    assert.equal(motion.step(LANYARD_STEP, false), false)
    assert.equal(motion.phase, 'pending')
    motion.cancel()
    assert.equal(motion.phase, 'idle')
    assert.equal(badge.angvel().y, 8)
    assert.equal(motion.step(LANYARD_STEP, false), false)
  } finally { world.free() }
})
