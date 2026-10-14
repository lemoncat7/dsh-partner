import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { drawBadge, type BadgeMessage } from './badge-art.js'
import { drawCardImage, loadCardImage } from './card-image.js'
import type { PendantSettings } from './settings.js'

/** Same resting geometry as the physical card, without loading its engine. */
export function staticPendantLayout(width: number, height: number, length: number) {
  const scale = height / (20 * Math.tan(Math.PI / 12))
  const x = width / 2 + .015 * scale
  const y = height / 2 + (3 * length / 100 - 1.45) * scale
  const cardHeight = Math.max(44, scale * 1.99)
  return { x, y, width: Math.max(44, scale * 1.45), height: cardHeight,
    badgeY: y - cardHeight / 2 - 8, hookY: height / 2 - 2.55 * scale,
    strapWidth: Math.max(4, scale * .17), strapHeight: 3 * length / 100 * scale }
}

export function useStaticPendantLayout(root: RefObject<HTMLElement>, hit: RefObject<HTMLButtonElement>, badge: RefObject<HTMLElement>, active: boolean, length: number): void {
  useLayoutEffect(() => {
    const element = root.current, button = hit.current
    if (!active || !element || !button) return
    const layout = () => {
      const p = staticPendantLayout(element.clientWidth, element.clientHeight, length)
      button.style.width = `${p.width}px`; button.style.height = `${p.height}px`
      button.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`
      if (badge.current) badge.current.style.transform = `translate(${p.x}px, ${p.badgeY}px) translate(-50%, -100%)`
      element.style.setProperty('--pendant-static-hook', `${p.hookY}px`)
      element.style.setProperty('--pendant-static-strap-height', `${p.strapHeight}px`)
      element.style.setProperty('--pendant-static-strap-width', `${p.strapWidth}px`)
    }
    layout()
    const observer = new ResizeObserver(layout); observer.observe(element)
    return () => observer.disconnect()
  }, [root, hit, badge, active, length])
}

export function StaticPendantCard({ settings, message }: { settings: PendantSettings; message: BadgeMessage | undefined }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let disposed = false
    drawBadge(canvas, !!message?.count, message)
    // The message face takes precedence, just like the 3D card.
    if (settings.image && !message?.count) void loadCardImage(settings.image).then(image => {
      if (!disposed) drawCardImage(canvas, image, settings.imageFit)
    }).catch(() => { /* The default artwork remains available. */ })
    return () => { disposed = true }
  }, [settings.image, settings.imageFit, message?.id, message?.count, message?.name, message?.label])
  return <canvas ref={ref} width={256} height={352} className="dsh-partner-pendant-static-art" aria-hidden="true" />
}
