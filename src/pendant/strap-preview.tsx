import { useMemo } from 'react'
import type { PendantSettings } from './settings.js'
import { strapGeometry } from './strap-geometry.js'

export function StrapPreview({ material, color, swatch = false }: Pick<PendantSettings, 'material' | 'color'> & { swatch?: boolean }): JSX.Element {
  const layers = useMemo(() => strapGeometry(swatch ? [{ x: 8, y: 20 }, { x: 112, y: 20 }] : [{ x: 50, y: 6 }, { x: 50, y: 127 }], { material, color }, swatch ? 100 : 72), [material, color, swatch])
  return <svg className={swatch ? 'dsh-partner-strap-swatch' : undefined} viewBox={swatch ? '0 0 120 40' : '0 0 100 130'} aria-hidden="true">
    {layers.map(layer => <path key={layer.id} d={layer.d} fill="none" stroke={layer.stroke} strokeWidth={layer.width} opacity={layer.opacity} strokeLinecap="round" strokeLinejoin="round" />)}
    {!swatch && <rect x="42" y="3" width="16" height="6" rx="3" fill="#c3ced0" />}
  </svg>
}
