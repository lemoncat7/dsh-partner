/** Only the persistence service's explicit missing-identity error permits creation. */
export function isMissingSession(error: unknown, id: string): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as {name?: unknown; sessionId?: unknown}
  return value.name === 'SessionPersistenceNotFoundError' && value.sessionId === id
}

export class SessionRecoveryJobs<T> {
  private readonly jobs = new Map<string, Promise<T>>()
  run(id: string, action: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(id)
    if (existing) return existing
    const job = Promise.resolve().then(action).finally(() => {
      if (this.jobs.get(id) === job) this.jobs.delete(id)
    })
    this.jobs.set(id, job)
    return job
  }
}
