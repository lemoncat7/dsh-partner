import test from 'node:test'
import assert from 'node:assert/strict'
import { strapTextureTransform, STRAP_TEXTURE_SEGMENTS } from '../lib/pendant/strap-texture.js'

const matrix = (...args) => strapTextureTransform(...args).slice(7, -1).split(' ').map(Number)
const project = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-8))

test('texture material endpoints stay on moving, rotating and stretching rope samples', () => {
  for (const [a, b] of [[{x:0,y:0},{x:0,y:5}], [{x:120,y:30},{x:128,y:36}], [{x:-30,y:20},{x:-40,y:2}]]) {
    for (const i of [0, 12, STRAP_TEXTURE_SEGMENTS - 1]) {
      const m = matrix(a, b, 8, i)
      near(project(m, .5, i), [a.x, a.y])
      near(project(m, .5, i + 1), [b.x, b.y])
      assert.ok(Math.abs(Math.hypot(m[0], m[1]) - 8) < 1e-8)
    }
  }
})

test('collapsed rope samples remain finite without extra geometry', () => {
  assert.equal(STRAP_TEXTURE_SEGMENTS, 48)
  assert.ok(matrix({x:1,y:2}, {x:1,y:2}, 8, 47).every(Number.isFinite))
})
