import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { createBadgeFaceMaterial, BADGE_LIGHTING, badgePixelRatio, configureBadgeTexture } from '../lib/pendant/surface.js'
import { createMotionGlare } from '../lib/pendant/motion-glare.js'

test('both faces retain physical coating with explicit environment strength and original shading', () => {
  const texture = new THREE.Texture(), environment = new THREE.Texture()
  const front = createBadgeFaceMaterial(texture, environment), back = createBadgeFaceMaterial(texture, environment)
  try {
    assert.notEqual(front, back, 'faces own independently disposable materials')
    for (const material of [front, back]) {
      assert.equal(material.map, texture)
      assert.equal(material.isMeshPhysicalMaterial, true)
      assert.equal(material.clearcoat, .45)
      assert.equal(material.clearcoatRoughness, .16)
      assert.equal(material.roughness, .24)
      assert.equal(material.specularIntensity, .35)
      assert.equal(material.envMapIntensity, .18)
      assert.equal(material.transmission, 0, 'no extra transmission render target')
      assert.equal(material.envMap, environment, 'explicit environment keeps material intensity effective in Three r185')
      assert.equal(material.toneMapped, true, 'only the reflection is tone-mapped before source compositing')
      assert.equal(material.opacity, 1, 'printed text/art remains legible')
    }
    assert.equal(BADGE_LIGHTING.ambient, 2.4, 'hardware lighting stays unchanged')
    assert.equal(BADGE_LIGHTING.key, 1.1, 'specular key light stays unchanged')
  } finally { front.dispose(); back.dispose(); texture.dispose(); environment.dispose() }
})

test('image colour bypasses lighting while native reflection is retained without deforming geometry', () => {
  const texture = new THREE.Texture(), material = createBadgeFaceMaterial(texture)
  try {
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} }
    material.onBeforeCompile(shader, {})
    assert.equal(shader.vertexShader, THREE.ShaderLib.physical.vertexShader)
    assert.match(shader.fragmentShader, /linearToOutputTexel\(diffuseColor\)/)
    assert.match(shader.fragmentShader, /clearcoatSpecularDirect \+ clearcoatSpecularIndirect/)
    assert.match(shader.fragmentShader, /outgoingLight = max\(badgeReflection/)
    assert.match(shader.fragmentShader, /badgeImage \+ \(vec3\(1.0\) - badgeImage\) \* badgeCoating/)
    assert.deepEqual(shader.uniforms, {})
    assert.equal(material.customProgramCacheKey(), 'partner-image-coating-v1')
    assert.throws(() => material.onBeforeCompile({ fragmentShader: '', uniforms: {} }, {}), /output hooks missing/)
  } finally { material.dispose(); texture.dispose() }
})

test('front glare shares uniforms without changing normals, geometry or the message face', () => {
  const texture = new THREE.Texture(), environment = new THREE.Texture()
  const glare = createMotionGlare()
  const front = createBadgeFaceMaterial(texture, environment, glare.uniforms), back = createBadgeFaceMaterial(texture, environment)
  try {
    assert.equal(front.clearcoat, .45)
    assert.equal(front.clearcoatRoughness, .16)
    assert.equal(back.clearcoat, .45)
    assert.equal(back.clearcoatRoughness, .16)
    assert.notEqual(front.customProgramCacheKey(), back.customProgramCacheKey())
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} }
    front.onBeforeCompile(shader, {})
    assert.doesNotMatch(shader.fragmentShader, /clearcoatNormal = normalize|mirrorCurve/)
    assert.match(shader.fragmentShader, /linearToOutputTexel\(diffuseColor\)/)
    assert.match(shader.fragmentShader, /glareBand/)
    assert.doesNotMatch(shader.vertexShader, /position\s*[+*]?=|uv\s*[+*]?=/)
    assert.equal(shader.vertexShader, THREE.ShaderLib.physical.vertexShader)
    assert.equal(shader.uniforms.badgeGlareOpacity, glare.uniforms.badgeGlareOpacity)
    assert.equal(shader.uniforms.badgeGlareProgress, glare.uniforms.badgeGlareProgress)
    const runtime = readFileSync(new URL('../src/pendant/renderer.ts', import.meta.url), 'utf8')
    assert.match(runtime, /createBadgeFaceMaterial\(frontTexture, environment.texture, glare.uniforms\)/)
    assert.match(runtime, /createBadgeFaceMaterial\(backTexture, environment.texture\)/)
  } finally { front.dispose(); back.dispose(); texture.dispose(); environment.dispose() }
})

test('small high-DPI render target and oblique texture sampling are bounded', () => {
  for (const [input, expected] of [[1,1],[1.25,1.25],[2,2],[3,2],[4,2],[NaN,1],[0,1]]) assert.equal(badgePixelRatio(input), expected)
  const texture = new THREE.Texture()
  try {
    configureBadgeTexture(texture, 16)
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace)
    assert.equal(texture.anisotropy, 4)
    configureBadgeTexture(texture, 1)
    assert.equal(texture.anisotropy, 1)
  } finally { texture.dispose() }
})
