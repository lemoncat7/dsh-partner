import type { PartnerStore } from '../store.js'

/** Wait for this schedule's durable receipt, never for the whole conversation/Goal. */
export async function deliverScheduledWake(input: {
  store: PartnerStore
  id: string
  token: string
  signal: AbortSignal
  timeoutMs: number
  deliver(): void
}): Promise<void> {
  input.signal.throwIfAborted()
  let dispose = (): void => {}
  let timer: NodeJS.Timeout | undefined
  let cancel = (): void => {}
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (error?: Error): void => { if (settled) return; settled = true; error ? reject(error) : resolve() }
      const check = (): boolean => {
        const entry = input.store.snapshot().schedules.find(s => s.id === input.id), wake = entry?.continuation
        if (!entry || wake?.state === 'cancelled') { done(new Error('续接已取消')); return false }
        if (!input.store.hasCapability(entry.companionId, 'schedules')) { done(new Error('定时任务能力已撤回')); return false }
        if (wake?.runToken !== input.token || wake.state !== 'running') { done(); return false }
        if (!entry.enabled) { done(new Error('续接已暂停')); return false }
        return true
      }
      dispose = input.store.subscribe(() => { check() }, error => done(error instanceof Error ? error : new Error('续接状态读取失败')))
      cancel = () => done(new Error('续接等待已中止'))
      input.signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => done(new Error(`本次定时检查超过 ${Math.round(input.timeoutMs / 60_000)} 分钟，未收到结果，已暂停；原会话未被中断`)), input.timeoutMs)
      timer.unref?.()
      if (input.signal.aborted) { cancel(); return }
      if (check()) input.deliver()
    })
  } finally {
    dispose(); if (timer) clearTimeout(timer)
    input.signal.removeEventListener('abort', cancel)
  }
}
