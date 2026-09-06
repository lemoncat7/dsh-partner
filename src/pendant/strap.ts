import { CatmullRomCurve3, Vector3 } from 'three'
import { strapGeometry, type StrapPoint } from './strap-geometry.js'
import { DEFAULT_PENDANT_SETTINGS, type PendantSettings } from './settings.js'

/** Fixed SVG layer pool, separate from the bounded WebGL card buffer. */
export function createLanyardStrap(canvas: HTMLCanvasElement) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('dsh-partner-pendant-strap'); svg.setAttribute('aria-hidden', 'true')
  const paths = Array.from({ length: 8 }, () => {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('fill', 'none'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round')
    svg.append(path); return path
  })
  const stud = document.createElementNS(ns, 'circle')
  stud.setAttribute('fill', '#c3ced0'); stud.setAttribute('stroke', '#667578'); stud.setAttribute('stroke-width', '1')
  svg.append(stud); canvas.before(svg)
  const curve = new CatmullRomCurve3(Array.from({ length: 4 }, () => new Vector3())), point = new Vector3()
  const projected: StrapPoint[] = Array.from({ length: 49 }, () => ({ x: 0, y: 0 }))
  let appearance: Pick<PendantSettings, 'material' | 'color'> = DEFAULT_PENDANT_SETTINGS, currentScale = 58
  let stylesDirty = true
  const redraw = (): void => {
    const layers = strapGeometry(projected, appearance, currentScale)
    paths.forEach((path, i) => {
      const layer = layers[i]
      if (stylesDirty) path.style.display = layer ? '' : 'none'
      if (!layer) return
      path.setAttribute('d', layer.d)
      if (stylesDirty) {
        path.dataset.layer = layer.id; path.setAttribute('stroke', layer.stroke)
        path.setAttribute('stroke-width', String(layer.width)); path.setAttribute('opacity', String(layer.opacity))
      }
    })
    if (layers.length) stylesDirty = false
  }
  return {
    resize(scale: number) { currentScale = scale; stylesDirty = true; stud.setAttribute('r', String(scale * .06)); redraw() },
    setAppearance(settings: PendantSettings) {
      if (appearance.material === settings.material && appearance.color === settings.color && svg.dataset.material) return
      appearance = { material: settings.material, color: settings.color }
      stylesDirty = true
      svg.dataset.material = settings.material; svg.dataset.color = settings.color; redraw()
    },
    paint(points: ReadonlyArray<{ x: number; y: number; z: number }>, originX: number, originY: number, scale: number) {
      currentScale = scale
      points.forEach((p, i) => curve.points[i]!.copy(p))
      for (let i = 0; i < projected.length; i++) {
        curve.getPoint(i / (projected.length - 1), point)
        projected[i]!.x = originX + point.x * scale; projected[i]!.y = originY - point.y * scale
      }
      redraw()
      stud.setAttribute('cx', String(projected[0]!.x)); stud.setAttribute('cy', String(projected[0]!.y))
    },
    destroy() { svg.remove() },
  }
}
