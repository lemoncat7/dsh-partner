import type RAPIER from '@dimforge/rapier3d-compat'

/** One interruptible notice gesture, driven by the existing fixed physics step.
 * Only a brief orientation assist owns angular velocity; ordinary play is free.
 * Multiple arrivals coalesce; a held/thrown card is never seized by a notice.
 */
export function createNoticeMotion(badge: RAPIER.RigidBody) {
  let phase: 'idle' | 'pending' | 'turning' = 'idle', elapsed = 0
  return {
    get phase() { return phase },
    request() { if (phase === 'idle') phase = 'pending' },
    cancel() { phase = 'idle'; elapsed = 0 },
    step(dt: number, held: boolean): boolean {
      if (phase === 'idle' || held) return false
      if (phase === 'pending') {
        const v = badge.linvel(), a = badge.angvel()
        if (Math.hypot(v.x, v.y, v.z) > 2 || Math.hypot(a.x, a.y, a.z) > 2) return false
        phase = 'turning'; elapsed = 0
        badge.applyImpulse({ x: .45, y: .06, z: 0 }, true)
      }
      elapsed += dt
      const q = badge.rotation(), sign = q.w < 0 ? -1 : 1
      const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)))
      // Inverse quaternion is the shortest world-space rotation to the upright
      // art face. Angular velocity keeps Rapier and the visible card in sync.
      const sine = Math.hypot(q.x, q.y, q.z)
      const speed = sine > .0001 ? Math.min(3.2, angle * 7) * sign / sine : 0
      badge.setAngvel({ x: -q.x * speed, y: -q.y * speed, z: -q.z * speed }, true)
      if ((angle < .025 && elapsed >= .5) || elapsed >= 2.5) {
        phase = 'idle'; elapsed = 0
        return angle < .12 // Do not flash the wrong face if physics was disturbed.
      }
      return false
    },
  }
}
