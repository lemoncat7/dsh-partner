import {useCallback, useEffect, useRef, useState} from 'react'
import {api} from '../../client-api.js'
import {errorMessage} from '../workspace-components.js'

/** Only the latest request may publish. Polls pause while the page is hidden,
 * never overlap, and never reset an editor's local draft. */
export function useMemoryResource<T>(path: string | undefined, pollMs = 0) {
  const [snapshot, setData] = useState<{path: string; value: T}>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0)
  const request = useRef<AbortController>()
  const reload = useCallback(async (): Promise<void> => {
    if (!path) return
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    const revision = ++sequence.current
    setLoading(true)
    try {
      const result = await api<T>(path, {signal: controller.signal})
      if (revision === sequence.current && !controller.signal.aborted) {setData({path, value: result}); setError(undefined)}
    } catch (reason) {
      if (revision === sequence.current && !controller.signal.aborted) setError(errorMessage(reason))
    } finally {if (revision === sequence.current) setLoading(false)}
  }, [path])
  useEffect(() => {
    setData(undefined); setError(undefined); setLoading(Boolean(path))
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {if (timer) clearTimeout(timer); if (!disposed && pollMs > 0) timer = setTimeout(() => {void tick()}, pollMs)}
    const tick = async (): Promise<void> => {
      if (disposed) return
      if (!document.hidden) await reload()
      schedule()
    }
    const visible = (): void => {if (!document.hidden) {if (timer) clearTimeout(timer); void tick()}}
    void reload().then(schedule)
    if (pollMs) document.addEventListener('visibilitychange', visible)
    return () => {disposed = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible); ++sequence.current; request.current?.abort()}
  }, [reload, pollMs])
  return {data: snapshot?.path === path ? snapshot?.value : undefined, error, loading, reload}
}
