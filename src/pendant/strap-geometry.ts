import type { PendantSettings } from './settings.js'
import { strapStyle } from './strap-style.js'

export interface StrapPoint { x: number; y: number }
export interface StrapLayer { id: string; d: string; stroke: string; width: number; opacity: number }
const point = (p: StrapPoint): string => p.x.toFixed(2) + ' ' + p.y.toFixed(2)

/** Shared live/preview geometry. Texture follows arc distance/tangent, not
 * screen axes. At most 256 samples / 8 paths, no filters or per-thread nodes.
 */
export function strapGeometry(points: readonly StrapPoint[], settings: Pick<PendantSettings, 'material' | 'color'>, scale: number): StrapLayer[] {
  if (points.length < 2 || !Number.isFinite(scale) || scale <= 0 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return []
  const style = strapStyle(settings), width = style.width * scale
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y))
  const total = lengths.at(-1)!
  if (total < .01) return []
  const count = Math.min(256, Math.max(2, Math.ceil(total / Math.max(1.5, width * .18))))
  let segment = 1
  const samples = Array.from({ length: count + 1 }, (_, i) => {
    const distance = total * i / count
    while (segment < points.length - 1 && lengths[segment]! < distance) segment++
    const a = points[segment - 1]!, b = points[segment]!, length = lengths[segment]! - lengths[segment - 1]!
    const t = length > 0 ? (distance - lengths[segment - 1]!) / length : 0
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: length ? -(b.y - a.y) / length : 1, ny: length ? (b.x - a.x) / length : 0, distance }
  })
  const at = (i: number, offset: number): StrapPoint => { const p = samples[i]!; return { x: p.x + p.nx * offset, y: p.y + p.ny * offset } }
  const line = (offset: number | ((distance: number) => number)): string => samples.map((p, i) => (i ? 'L' : 'M') + point(at(i, typeof offset === 'number' ? offset : offset(p.distance)))).join('')
  const layers: StrapLayer[] = []
  const add = (id: string, d: string, stroke: string, thickness: number, opacity = 1): void => { layers.push({ id, d, stroke, width: thickness, opacity }) }
  add('edge', line(0), style.edge, width)
  add('surface', line(0), style.band, width * .84)
  if (settings.material === 'woven') {
    add('selvedge', line(-width * .36) + line(width * .36), style.light, width * .065, .85)
    add('warp', line(-width * .15) + line(width * .15), style.shade, width * .075, .7)
    let ribs = ''
    for (let i = 1; i < count; i += 2) ribs += 'M' + point(at(i, -width * .3)) + 'L' + point(at(i, width * .3))
    add('weft', ribs, style.thread, Math.max(.55, width * .07), .6)
  } else if (settings.material === 'leather') {
    add('rolled-edge', line(-width * .37), style.light, width * .09, .75)
    add('polish', line(-width * .11), style.light, width * .22, .16)
    let stitches = ''
    for (let i = 1; i < count - 1; i += 4) for (const side of [-1, 1]) stitches += 'M' + point(at(i, side * width * .28)) + 'L' + point(at(i + 1, side * width * .28))
    add('seam-shadow', stitches, style.edge, width * .16, .85)
    add('double-stitch', stitches, style.thread, Math.max(.65, width * .085))
  } else {
    const pitch = width * 1.2
    const wave = (distance: number): number => Math.sin(distance / pitch * Math.PI * 2) * width * .27
    const left = line(wave), right = line(distance => -wave(distance))
    add('strand-grooves', left + right, style.edge, width * .42)
    add('strand-body', left + right, style.light, width * .27, .8)
    let over = '', lit = ''
    for (let i = 0; i < count; i++) {
      const s = samples[i]!, end = samples[i + 1]!
      const sign = Math.cos((s.distance + end.distance) / 2 / pitch * Math.PI * 2) >= 0 ? 1 : -1
      const a = wave(s.distance) * sign, b = wave(end.distance) * sign
      over += 'M' + point(at(i, a)) + 'L' + point(at(i + 1, b))
      lit += 'M' + point(at(i, a - width * .055)) + 'L' + point(at(i + 1, b - width * .055))
    }
    add('overpass', over, style.band, width * .25)
    add('strand-sheen', lit, style.thread, width * .095, .95)
  }
  return layers
}
