/** Page-memory only; mutations invalidate both cached and in-flight reads. */
export function createSnapshotCache<T>(fetchValue: () => Promise<T>, ttl = 30_000) {
  let value: T | undefined
  let expires = 0
  let revision = 0
  let pending: Promise<T> | undefined
  const peek = (): T | undefined => Date.now() < expires ? value : undefined
  const invalidate = (): void => { revision++; value = undefined; expires = 0; pending = undefined }
  const load = (): Promise<T> => {
    if (pending) return pending
    const started = revision
    const request = fetchValue().then(next => {
      if (started !== revision) return load()
      value = next; expires = Date.now() + ttl
      return next
    }).finally(() => { if (pending === request) pending = undefined })
    pending = request
    return request
  }
  return { peek, load, invalidate }
}
