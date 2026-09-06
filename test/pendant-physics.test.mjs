import assert from 'node:assert/strict'
import test from 'node:test'
import RAPIER from '@dimforge/rapier3d-compat'
import { createLanyardPhysics, LANYARD_STEP } from '../lib/pendant/physics.js'

await RAPIER.init()
const run = (world, seconds) => { for (let i = 0; i < Math.round(seconds / LANYARD_STEP); i++) world.step() }

test('held stretch stores energy and visibly overshoots on release without a throw impulse', () => {
  const { world, badge } = createLanyardPhysics()
  try {
    run(world, 5)
    const rest = badge.translation().y
    assert.ok(Math.abs(rest - .05) < .03, 'loaded tether stays in its display bounds')
    badge.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
    badge.setNextKinematicTranslation({ x: 0, y: rest - 2, z: 0 })
    run(world, 2)
    badge.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    badge.setLinvel({ x: 0, y: 0, z: 0 }, true)
    let high = rest - 2, lowAfterPeak = Infinity
    for (let i = 0; i < 240; i++) {
      world.step()
      const y = badge.translation().y
      high = Math.max(high, y)
      if (i > 90) lowAfterPeak = Math.min(lowAfterPeak, y)
    }
    assert.ok(high > rest + .7, 'recoil crosses equilibrium, not just a slow return')
    assert.ok(lowAfterPeak < rest - .05, 'elastic return includes a second bounce')
    run(world, 30)
    assert.ok(badge.isSleeping(), 'elastic motion eventually sleeps')
    assert.ok(Math.abs(badge.translation().y - rest) < .05, 'no permanent rope stretch')
  } finally { world.free() }
})

test('spherical badge attachment permits full front/back flipping and settles afterwards', () => {
  const { world, badge } = createLanyardPhysics()
  try {
    run(world, 3)
    badge.setAngvel({ x: 0, y: 12, z: 0 }, true)
    let front = false, back = false
    for (let i = 0; i < 240; i++) {
      world.step()
      const q = badge.rotation(), facing = 1 - 2 * (q.x * q.x + q.y * q.y)
      front ||= facing > .8; back ||= facing < -.8
    }
    assert.ok(front && back, 'both faces are exposed by the same throw')
    run(world, 30)
    assert.ok(badge.isSleeping())
  } finally { world.free() }
})

test('sleeping a held stretch preserves elastic recoil and can move again', () => {
  const { world, badge, beads } = createLanyardPhysics()
  try {
    run(world, 5)
    const rest = badge.translation().y
    badge.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
    badge.setNextKinematicTranslation({ x: 0, y: rest - 2.7, z: 0 })
    run(world, 8)
    const stored = badge.translation().y
    for (const b of [badge, ...beads]) b.sleep()
    assert.equal(badge.translation().y, stored)
    badge.setNextKinematicTranslation({ x: .2, y: stored, z: 0 })
    for (const b of beads) b.wakeUp()
    run(world, .1)
    assert.ok(Math.abs(badge.translation().x - .2) < .01)
    badge.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    badge.setLinvel({ x: 0, y: 0, z: 0 }, true)
    let peak = stored
    for (let i = 0; i < 240; i++) { world.step(); peak = Math.max(peak, badge.translation().y) }
    assert.ok(peak > rest + .5, 'sleeping does not erase spring energy')
  } finally { world.free() }
})

test('large diagonal stretch remains finite through release and repeated grabbing', () => {
  const { world, badge, beads } = createLanyardPhysics()
  try {
    for (const target of [{ x: -9, y: -5, z: 0 }, { x: 6, y: 3, z: 0 }, { x: -1, y: -2, z: 0 }]) {
      badge.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
      badge.setNextKinematicTranslation(target); run(world, 1)
      badge.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      badge.setLinvel({ x: 0, y: 0, z: 0 }, true)
      run(world, 2)
      for (const b of [badge, ...beads]) assert.ok(Object.values(b.translation()).every(Number.isFinite))
    }
    run(world, 35)
    assert.ok(badge.isSleeping())
    assert.ok(Math.abs(badge.translation().y - .05) < .05)
  } finally { world.free() }
})
