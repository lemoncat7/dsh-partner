import RAPIER from '@dimforge/rapier3d-compat'
import { normalizeStrapLength } from './settings.js'

export const LANYARD_STEP = 1 / 120

/** Call after Rapier initialization. Elastic links store the energy of a held
 * stretch; unlike maximum-length rope joints, they recoil even after a pause.
 * Rendering, pointer sampling and resource scheduling stay outside this module.
 */
export function createLanyardPhysics() {
  const world = new RAPIER.World({ x: 0, y: -40, z: 0 })
  world.timestep = LANYARD_STEP
  world.numSolverIterations = 12
  const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 4.15, 0))
  const beads = [3.15, 2.15, 1.15].map(y => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(.015, y, 0).setLinearDamping(.7).setAngularDamping(.7))
    world.createCollider(RAPIER.ColliderDesc.ball(.035).setMass(.25).setCollisionGroups(0), body)
    return body
  })
  const badge = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(.015, .05, 0).setLinearDamping(.45).setAngularDamping(.45))
  world.createCollider(RAPIER.ColliderDesc.cuboid(.71, .98, .04).setMass(1).setCollisionGroups(0), badge)
  const bodies = [anchor, ...beads]
  // Average supported weight is 60 force units per link. Compensating its
  // static extension keeps the loaded strap at 3 world units as stiffness is
  // tuned. Underdamping preserves recoil, without launching ordinary pulls.
  const stiffness = 220, restLength = 1 - 60 / stiffness
  const springs: RAPIER.ImpulseJoint[] = []
  for (let i = 0; i < 3; i++) springs.push(world.createImpulseJoint(
    RAPIER.JointData.spring(restLength, stiffness, 6, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    bodies[i]!, bodies[i + 1]!, true,
  ))
  world.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 1.1, z: 0 }), beads[2]!, badge, true)
  let length = 100
  const setLength = (value: number): void => {
    const next = normalizeStrapLength(value)
    if (next === length) return
    length = next
    const segment = next / 100
    for (const joint of springs) world.removeImpulseJoint(joint, true)
    springs.length = 0
    for (let i = 0; i < 3; i++) {
      beads[i]!.setTranslation({ x: .015, y: 4.15 - segment * (i + 1), z: 0 }, true)
      springs.push(world.createImpulseJoint(RAPIER.JointData.spring(segment - 60 / stiffness, stiffness, 6, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), bodies[i]!, bodies[i + 1]!, true))
    }
    badge.setTranslation({ x: .015, y: 4.15 - 3 * segment - 1.1, z: 0 }, true)
    for (const body of [...beads, badge]) { body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true) }
  }
  return { world, anchor, beads, badge, bodies, setLength }
}
