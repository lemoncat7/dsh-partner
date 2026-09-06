import type { PendantSettings } from './settings.js'

function mix(color: string, target: number, amount: number): string {
  const channels = [1, 3, 5].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * (1 - amount) + target * amount))
  return '#' + channels.map(value => value.toString(16).padStart(2, '0')).join('')
}

/** World-unit width and color-relative textile lighting. */
export function strapStyle({ color, material }: Pick<PendantSettings, 'color' | 'material'>) {
  return {
    width: { woven: .17, braided: .145, leather: .195 }[material],
    band: color, edge: mix(color, 0, .52), shade: mix(color, 0, .3),
    light: mix(color, 255, .48), thread: mix(color, 255, .72),
  }
}
