import { useCallback, useEffect, useRef } from 'react'

/** Polls without overlap. Explicit refresh invalidates any older response. */
export function useBoardRefresh(read: () => Promise<() => void>, failed: (error: unknown) => void, enabled = true): () => Promise<void> {
  const readRef = useRef(read), failedRef = useRef(failed)
  readRef.current = read; failedRef.current = failed
  const epoch = useRef(0), pending = useRef<Promise<void> | undefined>(), mounted = useRef(false)
  const refresh = useCallback(async () => {
    const version = ++epoch.current
    await pending.current
    if (!mounted.current || version !== epoch.current) return
    const request = (async () => {
      try { const commit = await readRef.current(); if (mounted.current && version === epoch.current) commit() }
      catch (error) { if (mounted.current && version === epoch.current) failedRef.current(error) }
    })()
    pending.current = request
    await request
    if (pending.current === request) pending.current = undefined
  }, [])
  useEffect(() => {
    if (!enabled) return
    mounted.current = true
    void refresh()
    const poll = () => { if (!pending.current && document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(poll, 4000)
    document.addEventListener('visibilitychange', poll)
    return () => { mounted.current = false; epoch.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', poll) }
  }, [refresh, enabled])
  return refresh
}
