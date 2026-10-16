import {setTimeout as sleep} from 'node:timers/promises'

export interface ObservationRetry {
  attempt: number; delayMs: number; kind: string; status?: number
}

/** Only classify model/transport errors, never tool failures or arbitrary output. */
export function observationModelFailure(error: unknown): {kind: string; retryable: boolean; status?: number} {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const failure = value.failure && typeof value.failure === 'object' ? value.failure as Record<string, unknown> : value
  const message = typeof failure.message === 'string' ? failure.message : ''
  const code = typeof failure.code === 'string' ? failure.code : ''
  const status = typeof failure.status === 'number' ? failure.status
    : Number(message.match(/(?:OpenAI API error\s*\(|HTTP(?:\s+status)?\s*[:=]?\s*)(\d{3})/i)?.[1]) || undefined
  const result = (kind: string, retryable: boolean) => ({kind, retryable, ...(status === undefined ? {} : {status})})
  if (value.name === 'AbortError' || code === 'ABORTED' || code === 'CANCELLED') return result('unknown', false)
  if (status === 401 || status === 403 || /^(?:AUTH_ERROR|AUTHENTICATION|PERMISSION_DENIED)$/.test(code)) return result('authentication', false)
  // Respect rate limits via the scheduler, not blind short-interval retries.
  if (status === 429 || code === 'RATE_LIMIT') return result('rate_limited', false)
  if (status && status >= 400 && status < 500 && status !== 408) return result('unknown', false)
  if (/CERT_|certificate (?:has expired|verify failed)|self.signed certificate|hostname.*mismatch/i.test(message + ' ' + code)) return result('network', false)
  if ([408,500,502,503,504].includes(status ?? 0)
    || /^(?:NETWORK_ERROR|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(code)
    || /TLS handshake:\s*EOF|\bPROTOCOL_ERROR\b|socket hang up|connection reset|fetch failed|network error/i.test(message)) return result('network', true)
  return result('unknown', false)
}

/** Retry only a single model request. Tools run outside this boundary and cannot
 * be replayed. All attempts share the caller's original request deadline. */
export async function withObservationModelRetry<T>(run: () => Promise<T>, options: {
  signal: AbortSignal
  onRetry?(retry: ObservationRetry): void
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
}): Promise<T> {
  const delays = [1000, 3000]
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted()
    try { return await run() } catch (error) {
      const failure = observationModelFailure(error)
      const delayMs = delays[attempt - 1]
      if (options.signal.aborted || !failure.retryable || delayMs === undefined) throw error
      options.onRetry?.({attempt, delayMs, kind: failure.kind, ...(failure.status === undefined ? {} : {status: failure.status})})
      const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, {signal}))
      await wait(delayMs, options.signal)
    }
  }
}
