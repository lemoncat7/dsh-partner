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
      const q = badge.rotation()
      // Message face is the back mesh: target = a half-turn about Y, not
      // identity (artwork). Error = target * inverse(current), in world space.
      const ex = -q.z, ey = q.w, ez = q.x, ew = q.y
      const sign = ew < 0 ? -1 : 1
      const angle = 2 * Math.acos(Math.min(1, Math.abs(ew)))
      const sine = Math.hypot(ex, ey, ez)
      const speed = sine > .0001 ? Math.min(3.2, angle * 7) * sign / sine : 0
      badge.setAngvel({ x: ex * speed, y: ey * speed, z: ez * speed }, true)
      if ((angle < .025 && elapsed >= .5) || elapsed >= 2.5) {
        phase = 'idle'; elapsed = 0
        // Settle here without a return timer or persistent orientation lock.
        // Subsequent user gestures remain entirely governed by physics.
        if (angle < .12) badge.setAngvel({ x: 0, y: 0, z: 0 }, true)
        return angle < .12 // Do not flash the wrong face if physics was disturbed.
      }
      return false
    },
  }
}
