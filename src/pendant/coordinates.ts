/** Viewport origin of a fixed layer with CSS left/top = 0. Only call during
 * layout, never during physics steps or pointer movement. A transformed/filter
 * ancestor can make that origin differ from the viewport's (0, 0).
 */
export function measureFixedLayerOrigin(layer: Pick<HTMLElement, 'style' | 'getBoundingClientRect'>): { left: number; top: number } {
  const transform = layer.style.getPropertyValue('transform')
  const priority = layer.style.getPropertyPriority('transform')
  try {
    layer.style.setProperty('transform', 'none', 'important')
    const { left, top } = layer.getBoundingClientRect()
    return { left, top }
  } finally {
    if (transform) layer.style.setProperty('transform', transform, priority)
    else layer.style.removeProperty('transform')
  }
}
