import { useId, useMemo } from 'react'
import type { PendantSettings } from './settings.js'
import { strapGeometry } from './strap-geometry.js'

export function StrapPreview({ material, color, swatch = false, image = '', length = 100 }: Pick<PendantSettings, 'material' | 'color'> & { swatch?: boolean; image?: string; length?: number }): JSX.Element {
  const id = useId().replace(/:/g, '')
  const layers = useMemo(() => strapGeometry(swatch ? [{ x: 8, y: 20 }, { x: 112, y: 20 }] : [{ x: 50, y: 6 }, { x: 50, y: 127 }], { material, color }, swatch ? 100 : 72), [material, color, swatch])
  return <svg className={swatch ? 'dsh-partner-strap-swatch' : undefined} style={swatch ? undefined : { height: `${130 * length / 100}px` }} viewBox={swatch ? '0 0 120 40' : '0 0 100 130'} preserveAspectRatio="none" aria-hidden="true">
    {image && <defs><pattern id={id} patternUnits="userSpaceOnUse" width="24" height="24"><image href={image} width="24" height="24" preserveAspectRatio="xMidYMid slice" /></pattern></defs>}
    {layers.map(layer => <path key={layer.id} d={layer.d} fill="none" stroke={image && layer.id === 'surface' ? `url(#${id})` : layer.stroke} strokeWidth={layer.width} opacity={layer.opacity} strokeLinecap="round" strokeLinejoin="round" />)}
    {!swatch && <rect x="42" y="3" width="16" height="6" rx="3" fill="#c3ced0" />}
  </svg>
}
