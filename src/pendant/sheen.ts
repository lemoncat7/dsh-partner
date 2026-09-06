import * as THREE from 'three'

/** Two brief passes over the front art face, never a rectangular DOM
 * overlay or a full-screen bloom pass. Shares geometry; owns only its material.
 */
export function createBadgeSheen(card: THREE.Group, face: THREE.BufferGeometry) {
  const material = new THREE.ShaderMaterial({
    uniforms: { progress: { value: 0 } }, transparent: true, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 faceUv; void main() { faceUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 faceUv; uniform float progress;
      void main() {
        float center = mix(-0.5, 1.6, progress);
        float band = 1.0 - smoothstep(0.0, 0.22, abs(faceUv.x + faceUv.y * 0.35 - center));
        float fade = smoothstep(0.0, 0.14, progress) * (1.0 - smoothstep(0.8, 1.0, progress));
        gl_FragColor = vec4(0.88, 1.0, 0.95, band * fade * 0.38);
      }`,
  })
  const front = new THREE.Mesh(face, material)
  front.position.z = .067
  front.visible = false; card.add(front)
  let start: number | undefined
  return {
    start(now: number) { start = now },
    update(now: number, reduced: boolean): boolean {
      if (reduced || (start !== undefined && now - start >= 2800)) start = undefined
      const elapsed = start === undefined ? -1 : now - start
      front.visible = elapsed >= 0 && elapsed % 1400 < 1000
      material.uniforms.progress!.value = Math.max(0, elapsed % 1400) / 1000
      return start !== undefined
    },
    clear() { start = undefined; front.visible = false },
    dispose() { card.remove(front); material.dispose() },
  }
}
