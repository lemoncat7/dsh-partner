import { useEffect, type RefObject } from 'react'

export function useWorkspaceTopAnchor(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const element = ref.current
    const originalParent = element?.parentElement
    if (!element || !originalParent) return
    let moved = false
    let observer: MutationObserver | undefined
    const place = (): boolean => {
      let ancestor: HTMLElement | null = element.parentElement
      while (ancestor && ancestor !== document.body) {
        const candidate = ancestor.previousElementSibling
        if (candidate instanceof HTMLElement) {
          const style = getComputedStyle(candidate)
          if (style.display === 'flex' && style.flexDirection === 'column' && Number.parseFloat(style.flexGrow) > 0) {
            candidate.insertBefore(element, candidate.firstChild)
            moved = true
            return true
          }
        }
        ancestor = ancestor.parentElement
      }
      return false
    }
    if (!place()) {
      observer = new MutationObserver(() => { if (place()) observer?.disconnect() })
      observer.observe(document.body, { childList: true, subtree: true })
    }
    return () => {
      observer?.disconnect()
      if (moved && originalParent.isConnected) originalParent.append(element)
    }
  }, [ref])
}
