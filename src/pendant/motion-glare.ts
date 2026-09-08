export interface MotionGlareUniforms {
  badgeGlareProgress: { value: number }
  badgeGlareOpacity: { value: number }
}

// React Bits GlareHover gradient, positioned by orientation, never elapsed time.
// See docs/THIRD_PARTY_LICENSES.md for the upstream license and source.
export const MOTION_GLARE = { opacity: .38 } as const
interface Orientation { x: number; y: number; z: number; w: number }
const clamp = (n: number, low: number, high: number): number => Math.max(low, Math.min(high, n))

/** A fixed world-space light/view half-vector projected into the card frame.
 * Identical poses have identical highlights, even at rest or after reversal.
 * This is a stylized strip reflection, not an animated sweep or full ray trace.
 * Shares the existing frame; a visible highlight never keeps RAF awake.
 */
export function createMotionGlare() {
  const uniforms: MotionGlareUniforms = { badgeGlareProgress: { value: 1 }, badgeGlareOpacity: { value: 0 } }
  const clear = (): void => {
    uniforms.badgeGlareProgress.value = 1; uniforms.badgeGlareOpacity.value = 0
  }
  return {
    uniforms, clear,
    update(q: Orientation, reduced: boolean): void {
      const length = Math.hypot(q.x, q.y, q.z, q.w)
      if (reduced || !Number.isFinite(length) || length < 1e-8) { clear(); return }
      const x = q.x / length, y = q.y / length, z = q.z / length, w = q.w / length
      const facing = 1 - 2 * (x * x + y * y)
      if (facing <= .1) { clear(); return }
      const norm = Math.hypot(.25, .4, 1), hx = .25 / norm, hy = .4 / norm, hz = 1 / norm
      const localX = (1 - 2 * (y*y + z*z)) * hx + 2 * (x*y + z*w) * hy + 2 * (x*z - y*w) * hz
      const localY = 2 * (x*y - z*w) * hx + (1 - 2 * (x*x + z*z)) * hy + 2 * (y*z + x*w) * hz
      const localZ = 2 * (x*z + y*w) * hx + 2 * (y*z - x*w) * hy + facing * hz
      uniforms.badgeGlareProgress.value = clamp(.55 + .48 * (localX - localY), 0, 1)
      const visibility = clamp((facing - .1) / .3, 0, 1)
      uniforms.badgeGlareOpacity.value = MOTION_GLARE.opacity * visibility * visibility * (3 - 2 * visibility) * clamp(localZ, 0, 1)
    },
  }
}

/** Same -45deg / 250% / 60-70-85% CSS gradient in card-local coordinates.
 * Rendered inside the existing rounded face, not a new rectangular overlay.
 */
export const MOTION_GLARE_FRAGMENT = `
  #ifdef USE_MAP
    vec2 glareUv = (vec2(vMapUv.x, 1.0 - vMapUv.y)
      - vec2(mix(1.5, -1.5, badgeGlareProgress))) / 2.5;
    float glareInside = step(0.0, glareUv.x) * step(glareUv.x, 1.0)
      * step(0.0, glareUv.y) * step(glareUv.y, 1.0);
    float glareStop = 1.0 - dot(glareUv, vec2(1.42, 1.96)) / 3.38;
    float glareBand = clamp((glareStop - 0.60) / 0.10, 0.0, 1.0)
      * clamp((0.85 - glareStop) / 0.15, 0.0, 1.0);
    float glareAlpha = glareInside * glareBand * clamp(badgeGlareOpacity, 0.0, 0.5);
    gl_FragColor.rgb = mix(badgeImage, vec3(1.0), glareAlpha);
  #endif
`
