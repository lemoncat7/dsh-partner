import { useEffect, useRef, type RefObject, type MutableRefObject, type PointerEvent, type KeyboardEvent } from 'react'
import type { LanyardHandle } from './renderer.js'

const KEY = 'dsh-partner:pendant-position:v1'
interface Position { x: number; y: number }
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, Math.max(low, high)))

export function readerPlacement(anchor: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }) {
  const width = Math.min(360, viewport.width - 24), maxHeight = Math.min(480, viewport.height - 32), gap = 16
  const left = anchor.x - width - gap, right = anchor.x + anchor.width + gap
  if (left >= 12 || right + width <= viewport.width - 12) {
    return { width, maxHeight, left: clamp(left >= 12 ? left : right, 12, viewport.width - width - 12), top: clamp(anchor.y - 12, 16, viewport.height - maxHeight - 16) }
  }
  // Narrow screens: reserve the card's actual footprint, choose the larger
  // vertical space and scroll the message instead of covering the card.
  const below = clamp(anchor.y + anchor.height + gap, 16, viewport.height - 16)
  const above = clamp(anchor.y - gap, 16, viewport.height - 16)
  const useBelow = viewport.height - below - 16 >= above - 16
  const available = useBelow ? viewport.height - below - 16 : above - 16
  const height = Math.max(0, Math.min(maxHeight, available))
  return { width, maxHeight: height, left: clamp(anchor.x + anchor.width / 2 - width / 2, 12, viewport.width - width - 12), top: useBelow ? below : above - height }
}

/** Moving the hook changes placement, not the badge's elastic drag gesture.
 * Persist only at gesture completion; movement has no React render loop.
 */
export function usePendantPlacement(root: RefObject<HTMLElement>, handle: MutableRefObject<LanyardHandle | undefined>) {
  const handlers = useRef({ down: (_: PointerEvent<HTMLButtonElement>) => {}, move: (_: PointerEvent<HTMLButtonElement>) => {}, end: (_: PointerEvent<HTMLButtonElement>) => {}, key: (_: KeyboardEvent<HTMLButtonElement>) => {} })
  useEffect(() => {
    const element = root.current
    if (!element) return
    let saved: Position | undefined, pending: Position | undefined, frame = 0
    let drag: { id: number; x: number; y: number; left: number; top: number; button: HTMLButtonElement } | undefined
    try {
      const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Position | null
      if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) saved = { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) }
    } catch { /* Storage restrictions must not disable the pendant. */ }
    const limits = () => ({ x: Math.max(0, innerWidth - element.offsetWidth), y: Math.max(28, innerHeight - element.offsetHeight - 12) })
    const place = (p: Position): void => {
      const max = limits()
      element.style.left = `${clamp(p.x, 0, max.x)}px`; element.style.top = `${clamp(p.y, 28, max.y)}px`; element.style.right = 'auto'
      handle.current?.relayout()
    }
    const restore = (): void => {
      const max = limits()
      place(saved ? { x: saved.x * max.x, y: 28 + saved.y * (max.y - 28) } : { x: max.x - 8, y: 46 })
    }
    const flush = (): void => { cancelAnimationFrame(frame); frame = 0; if (pending) { place(pending); pending = undefined } }
    const persist = (): void => {
      const max = limits()
      saved = { x: parseFloat(element.style.left) / (max.x || 1), y: (parseFloat(element.style.top) - 28) / (max.y - 28 || 1) }
      try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* In-memory movement still works. */ }
    }
    const finish = (): void => {
      if (!drag) return
      const previous = drag; drag = undefined; flush(); persist()
      if (previous.button.hasPointerCapture(previous.id)) previous.button.releasePointerCapture(previous.id)
    }
    handlers.current = {
      down(event) {
        if (!event.isPrimary || event.button !== 0 || drag) return
        event.preventDefault()
        // CSS left/top are containing-block coordinates, not viewport pixels.
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop, button: event.currentTarget }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      move(event) {
        if (!drag || event.pointerId !== drag.id) return
        pending = { x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y }
        if (!frame) frame = requestAnimationFrame(flush)
      },
      end(event) { if (drag?.id === event.pointerId) finish() },
      key(event) {
        const step = event.shiftKey ? 32 : 12, delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
        if (!delta) return
        event.preventDefault()
        place({ x: element.offsetLeft + delta[0]!, y: element.offsetTop + delta[1]! }); persist()
      },
    }
    const resize = (): void => { finish(); restore() }
    const observer = new ResizeObserver(resize); observer.observe(element)
    window.addEventListener('resize', resize); window.addEventListener('blur', finish); restore()
    return () => { finish(); cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('blur', finish) }
  }, [root, handle])
  return { onPointerDown: (e: PointerEvent<HTMLButtonElement>) => handlers.current.down(e), onPointerMove: (e: PointerEvent<HTMLButtonElement>) => handlers.current.move(e), onPointerUp: (e: PointerEvent<HTMLButtonElement>) => handlers.current.end(e), onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => handlers.current.end(e), onLostPointerCapture: (e: PointerEvent<HTMLButtonElement>) => handlers.current.end(e), onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => handlers.current.key(e) }
}
