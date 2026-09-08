import assert from 'node:assert/strict'
import test from 'node:test'
import { createMotionGlare, MOTION_GLARE } from '../lib/pendant/motion-glare.js'

const pose = (angle, axis = 'y') => ({x:0, y:0, z:0, [axis]:Math.sin(angle/2), w:Math.cos(angle/2)})
const sample = (glare, q) => {
  glare.update(q, false)
  return [glare.uniforms.badgeGlareProgress.value, glare.uniforms.badgeGlareOpacity.value]
}

test('same angle stays fixed indefinitely at all frame rates without a sweep clock', () => {
  for (const fps of [24,30,60]) {
    const glare = createMotionGlare(), q = pose(.2), expected = sample(glare, q)
    const uniform = glare.uniforms.badgeGlareProgress
    for(let i=0;i<fps*10;i++) assert.deepEqual(sample(glare,q),expected)
    assert.equal(glare.uniforms.badgeGlareProgress,uniform)
    assert.ok(expected[1]>0, 'stationary angled card retains reflection')
  }
})

test('tilt moves reflection monotonically and reversing reproduces identical poses', () => {
  const glare = createMotionGlare(), angles = [-.5,-.25,0,.25,.5]
  for (const axis of ['x','y']) {
    const forward = angles.map(a=>sample(glare,pose(a,axis)))
    for(let i=1;i<forward.length;i++) assert.ok(forward[i][0]<forward[i-1][0])
    const reverse = [...angles].reverse().map(a=>sample(glare,pose(a,axis))).reverse()
    assert.deepEqual(reverse, forward)
    assert.ok(new Set(forward.map(s=>s[1])).size>2)
  }
})

test('quaternion signs and scale are equivalent; roll responds to world lighting', () => {
  const glare = createMotionGlare(), q = pose(.3), expected = sample(glare,q)
  for(const scale of [-1,2]) {
    const actual = sample(glare,Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v*scale])))
    actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-12))
  }
  assert.notDeepEqual(sample(glare,pose(.4,'z')),sample(glare,pose(-.4,'z')))
})

test('back, reduced motion and invalid poses clear; all angles remain bounded', () => {
  const glare = createMotionGlare()
  for (const q of [pose(Math.PI),{x:0,y:0,z:0,w:0},{x:NaN,y:0,z:0,w:1}]) {
    sample(glare,pose(0)); sample(glare,q)
    assert.equal(glare.uniforms.badgeGlareOpacity.value,0)
  }
  for(let i=-180;i<=180;i++) {
    const [position,opacity] = sample(glare,pose(i*Math.PI/180))
    assert.ok(position>=0&&position<=1)
    assert.ok(opacity>=0&&opacity<=MOTION_GLARE.opacity)
  }
  glare.update(pose(0),true)
  assert.equal(glare.uniforms.badgeGlareOpacity.value,0)
  sample(glare,pose(0)); glare.clear()
  assert.equal(glare.uniforms.badgeGlareOpacity.value,0)
})
