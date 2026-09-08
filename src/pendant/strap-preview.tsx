import { Fragment, useId, useMemo } from 'react'
import type { PendantSettings } from './settings.js'
import { strapGeometry } from './strap-geometry.js'
import { STRAP_TEXTURE_SEGMENTS, strapTextureTransform } from './strap-texture.js'

export function StrapPreview({ material, color, swatch = false, image = '', length = 100 }: Pick<PendantSettings, 'material' | 'color'> & { swatch?: boolean; image?: string; length?: number }): JSX.Element {
  const id = useId().replace(/:/g, '')
  const points = useMemo(() => Array.from({ length: STRAP_TEXTURE_SEGMENTS + 1 }, (_, i) => swatch ? { x: 8 + 104 * i / STRAP_TEXTURE_SEGMENTS, y: 20 } : { x: 50, y: 6 + 121 * i / STRAP_TEXTURE_SEGMENTS }), [swatch])
  const layers = useMemo(() => strapGeometry(swatch ? [{ x: 8, y: 20 }, { x: 112, y: 20 }] : [{ x: 50, y: 6 }, { x: 50, y: 127 }], { material, color }, swatch ? 100 : 72), [material, color, swatch])
  return <svg className={swatch ? 'dsh-partner-strap-swatch' : undefined} style={swatch ? undefined : { height: `${130 * length / 100}px` }} viewBox={swatch ? '0 0 120 40' : '0 0 100 130'} preserveAspectRatio="none" aria-hidden="true">
    {image && <defs><pattern id={id} patternUnits="userSpaceOnUse" width="1" height="4"><image href={image} width="1" height="4" preserveAspectRatio="none" /></pattern></defs>}
    {layers.map(layer => <Fragment key={layer.id}><path d={layer.d} fill="none" stroke={layer.stroke} strokeWidth={layer.width} opacity={layer.opacity} strokeLinecap="round" strokeLinejoin="round" />{image && layer.id === 'surface' && points.slice(0, -1).map((p, i) => <rect key={i} x="0" y={i - .005} width="1" height="1.01" fill={`url(#${id})`} transform={strapTextureTransform(p, points[i + 1]!, layer.width, i)} />)}</Fragment>)}
    {!swatch && <rect x="42" y="3" width="16" height="6" rx="3" fill="#c3ced0" />}
  </svg>
}
