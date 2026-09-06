import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createBadgeSheen } from '../lib/pendant/sheen.js'

test('sheen shares card geometry and ends after two short passes', () => {
  const card = new THREE.Group(), face = new THREE.PlaneGeometry(1, 1)
  const sheen = createBadgeSheen(card, face)
  try {
    assert.equal(card.children.length, 1, 'only the front art face carries sheen')
    assert.ok(card.children.every(mesh => mesh.geometry === face))
    sheen.start(100)
    assert.equal(sheen.update(600, false), true)
    assert.ok(card.children.every(mesh => mesh.visible))
    assert.equal(sheen.update(1250, false), true)
    assert.ok(card.children.every(mesh => !mesh.visible), 'pause between passes')
    assert.equal(sheen.update(1900, false), true)
    assert.ok(card.children.every(mesh => mesh.visible))
    assert.equal(sheen.update(2900, false), false)
    assert.ok(card.children.every(mesh => !mesh.visible))
  } finally { sheen.dispose(); face.dispose() }
  assert.equal(card.children.length, 0)
})

test('reading or reduced motion cancels sheen without a recurring render loop', () => {
  const card = new THREE.Group(), face = new THREE.PlaneGeometry(1, 1)
  const sheen = createBadgeSheen(card, face)
  try {
    sheen.start(0); sheen.clear()
    assert.equal(sheen.update(100, false), false)
    sheen.start(200)
    assert.equal(sheen.update(300, true), false)
    assert.equal(sheen.update(400, false), false, 'does not restart when motion preference changes back')
    assert.ok(card.children.every(mesh => !mesh.visible))
  } finally { sheen.dispose(); face.dispose() }
})
