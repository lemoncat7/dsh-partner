/** Decorative startup must not compete with the initial conversation render. */
export function waitForPendantStartup(signal: AbortSignal, doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = doc.defaultView!
    let timer = 0, idle = 0
    const started = Date.now()
    const cleanup = (): void => {
      win.clearTimeout(timer)
      if (idle) win.cancelIdleCallback?.(idle)
      doc.removeEventListener('visibilitychange', schedule)
      doc.removeEventListener('pointerdown', schedule)
      doc.removeEventListener('keydown', schedule)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    const run = (): void => {
      idle = 0
      if (signal.aborted) { abort(); return }
      if (doc.hidden) { schedule(); return }
      cleanup(); resolve()
    }
    function schedule(): void {
      win.clearTimeout(timer)
      if (idle) { win.cancelIdleCallback?.(idle); idle = 0 }
      if (doc.hidden) return
      // Leave at least two seconds for the host; input grants another quiet
      // interval, bounded so a busy user still gets the interactive pendant.
      const elapsed = Date.now() - started
      timer = win.setTimeout(() => {
        timer = 0
        if (win.requestIdleCallback) idle = win.requestIdleCallback(run, { timeout: 1500 })
        else run()
      }, Math.max(0, 2000 - elapsed, Math.min(600, 6000 - elapsed)))
    }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    doc.addEventListener('visibilitychange', schedule)
    doc.addEventListener('pointerdown', schedule, { passive: true })
    doc.addEventListener('keydown', schedule)
    schedule()
  })
}

export async function yieldPendantStartup(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  signal.throwIfAborted()
}
