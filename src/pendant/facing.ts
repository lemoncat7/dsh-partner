import type RAPIER from '@dimforge/rapier3d-compat'

/** Gentle rest orientation, never seizes a drag or an energetic throw. */
export function settleCardFacing(badge: RAPIER.RigidBody, back: boolean, held: boolean, reduced = false): boolean {
  if (held) return false
  const v = badge.linvel(), a = badge.angvel()
  if (Math.hypot(v.x, v.y, v.z) > .6 || Math.hypot(a.x, a.y, a.z) > 2) return false
  const q = badge.rotation()
  // Align the surface normal, not the entire quaternion: roll along the
  // screen plane belongs to the hanging strap and must remain free.
  const target = back ? -1 : 1
  const nx = 2 * (q.x * q.z + q.w * q.y), ny = 2 * (q.y * q.z - q.w * q.x)
  const nz = 1 - 2 * (q.x ** 2 + q.y ** 2)
  const angle = Math.acos(Math.max(-1, Math.min(1, nz * target)))
  // The strap's solver retains a small natural tilt. Do not repeatedly wake
  // the body to fight that tilt; a ~5 degree cone is still clearly face-on.
  if (angle < .09) {
    // Brake the assisted axes once inside the readable cone, otherwise the
    // last commanded velocity coasts through it and causes endless hunting.
    if (Math.hypot(a.x, a.y) > .001) badge.setAngvel({ x: 0, y: 0, z: a.z }, false)
    return false
  }
  if (reduced) {
    badge.setRotation(back ? { x: 0, y: 1, z: 0, w: 0 } : { x: 0, y: 0, z: 0, w: 1 }, true)
    badge.setAngvel({ x: 0, y: 0, z: 0 }, true)
    return false
  }
  const sine = Math.hypot(nx, ny), speed = Math.min(1.5, angle * 3)
  badge.setAngvel({ x: sine > .0001 ? ny * target * speed / sine : 0,
    y: sine > .0001 ? -nx * target * speed / sine : speed, z: a.z }, true)
  return true
}
