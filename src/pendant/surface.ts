import * as THREE from 'three'

export const BADGE_LIGHTING = { ambient: .4, key: 1.1 } as const

/** Clear coating over printed artwork, not a milky diffuse reflector.
 * Both faces share this recipe so the message side does not flare white.
 * No transmission buffer: a WebGL pass cannot refract the DOM behind it,
 * and the printed image should retain its contrast and custom colours.
 */
export function createBadgeFaceMaterial(map: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map, metalness: 0, roughness: .24,
    clearcoat: .45, clearcoatRoughness: .16,
    specularIntensity: .35, envMapIntensity: .18,
  })
}
