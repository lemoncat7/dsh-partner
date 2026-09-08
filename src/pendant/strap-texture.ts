import type { StrapPoint } from './strap-geometry.js'

export const STRAP_TEXTURE_SEGMENTS = 48

/** Material coordinates stay attached to a fixed curve sample, never the viewport. */
export function strapTextureTransform(a: StrapPoint, b: StrapPoint, width: number, index: number): string {
  const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy)
  const nx = distance > .0001 ? -dy / distance * width : width
  const ny = distance > .0001 ? dx / distance * width : 0
  return `matrix(${nx} ${ny} ${dx} ${dy} ${a.x - nx / 2 - dx * index} ${a.y - ny / 2 - dy * index})`
}
