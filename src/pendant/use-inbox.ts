import { useCallback, useEffect, useRef, useState } from 'react'
import { PARTNER_API, api } from '../client-api.js'
import type { PartnerInbox, PartnerNotice } from '../notifications/domain.js'

/** One conditional poll while visible, with bounded error backoff and cancellation. */
export function usePartnerInbox(): { inbox: PartnerInbox; incoming: PartnerNotice | undefined; error: string; read(ids: string[]): Promise<void> } {
  const [inbox, setInbox] = useState<PartnerInbox>({ items: [], unread: 0 })
  const [incoming, setIncoming] = useState<PartnerNotice>()
  const [error, setError] = useState('')
  const etag = useRef(''), latest = useRef<string>(), initialized = useRef(false), mounted = useRef(true), mutationEpoch = useRef(0)
  const apply = useCallback((value: PartnerInbox): void => {
    if (!mounted.current) return
    const first = value.items[0]
    if (initialized.current && first && first.id !== latest.current && first.readAt === undefined) setIncoming(first)
    initialized.current = true; latest.current = first?.id; setInbox(value); setError('')
  }, [])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined, failures = 0, stopped = false
    const poll = async (): Promise<void> => {
      if (stopped || document.hidden || request) return
      clearTimeout(timer)
      request = new AbortController()
      const epoch = mutationEpoch.current
      const timeout = setTimeout(() => request?.abort(), 12_000)
      try {
        const response = await fetch(`${PARTNER_API}/pendant/inbox`, { signal: request.signal, headers: etag.current ? { 'If-None-Match': etag.current } : {} })
        if (response.status !== 304) {
          if (!response.ok) throw new Error(`消息暂时不可用（${response.status}）`)
          const data = await response.json() as PartnerInbox
          if (!stopped && epoch === mutationEpoch.current) { etag.current = response.headers.get('etag') ?? ''; apply(data) }
        }
        failures = 0; if (!stopped) setError('')
      } catch (reason) { if (!stopped && !document.hidden) { failures++; setError(reason instanceof Error ? reason.message : '消息读取失败') } }
      finally {
        clearTimeout(timeout); request = undefined
        if (!stopped && !document.hidden) timer = setTimeout(() => { void poll() }, Math.min(30_000, 4_000 * 2 ** failures))
      }
    }
    const visibility = (): void => { clearTimeout(timer); if (document.hidden) request?.abort(); else void poll() }
    document.addEventListener('visibilitychange', visibility); void poll()
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', visibility) }
  }, [apply])
  const read = useCallback(async (ids: string[]): Promise<void> => {
    mutationEpoch.current++
    try { const value = await api<PartnerInbox>('/pendant/read', { method: 'POST', body: JSON.stringify({ ids }) }); mutationEpoch.current++; etag.current = ''; apply(value) }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '标记已读失败') }
  }, [apply])
  return { inbox, incoming, error, read }
}
