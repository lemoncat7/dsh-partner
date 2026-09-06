import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createBadgeFaceMaterial, BADGE_LIGHTING } from '../lib/pendant/surface.js'

test('card faces keep artwork contrast under a restrained clear coating', () => {
  const texture = new THREE.Texture()
  const front = createBadgeFaceMaterial(texture), back = createBadgeFaceMaterial(texture)
  try {
    assert.notEqual(front, back, 'faces own independently disposable materials')
    for (const material of [front, back]) {
      assert.equal(material.map, texture)
      assert.equal(material.metalness, 0)
      assert.ok(material.roughness < .3, 'avoid a broad milky reflection')
      assert.ok(material.clearcoat > 0 && material.clearcoat < .6)
      assert.ok(material.envMapIntensity < .25)
      assert.equal(material.transmission, 0, 'no offscreen refraction pass')
      assert.equal(material.opacity, 1, 'printed text/art remains legible')
    }
    assert.ok(BADGE_LIGHTING.ambient < .5)
    assert.ok(BADGE_LIGHTING.key < 1.5)
  } finally { front.dispose(); back.dispose(); texture.dispose() }
})
