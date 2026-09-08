import * as THREE from 'three'
import { separateImageCoating } from './image-coating.js'
import type { MotionGlareUniforms } from './motion-glare.js'

// Lights now affect the physical coating/hardware, not the source image.
export const BADGE_LIGHTING = { ambient: 2.4, key: 1.1 } as const

/** Preserve the source image separately from the original physical reflection. */
export function createBadgeFaceMaterial(map: THREE.Texture, environment?: THREE.Texture, glare?: MotionGlareUniforms): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    // Explicit map: Three r185 otherwise substitutes scene.environmentIntensity
    // for this material's envMapIntensity when inheriting scene.environment.
    map, envMap: environment ?? null, metalness: 0, roughness: .24,
    clearcoat: .45, clearcoatRoughness: .16,
    specularIntensity: .35, envMapIntensity: .18,
  })
  separateImageCoating(material, glare)
  return material
}

/** Native pixels for a small card only; do not supersample 3x/4x phones. */
export function badgePixelRatio(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 2) : 1
}

export function configureBadgeTexture(texture: THREE.Texture, maxAnisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(4, Math.max(1, maxAnisotropy))
}
