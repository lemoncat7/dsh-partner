import type { PartnerStore } from '../store.js'

/** A persisted deferral ends this board execution lease, not the shared conversation. */
export async function waitForBoardTurn(store: PartnerStore, delegationId: string, idle: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  let dispose = (): void => {}
  let abort = (): void => {}
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const check = (): void => {
        const item = store.snapshot().delegations.find(d => d.id === delegationId)
        if (item?.status === 'queued' && item.continuationScheduleId) resolve(true)
      }
      dispose = store.subscribe(check, reject)
      abort = () => reject(signal?.reason ?? new Error('看板执行已取消'))
      signal?.addEventListener('abort', abort, { once: true })
      idle.then(() => resolve(false), reject)
      if (signal?.aborted) abort()
      else check()
    })
  } finally { dispose(); signal?.removeEventListener('abort', abort) }
}
