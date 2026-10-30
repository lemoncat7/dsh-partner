export class AsyncSemaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive')
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try { return await operation() } finally { this.release() }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active += 1; return }
    await new Promise<void>(resolve => this.waiting.push(resolve))
    // The releasing owner transfers its reserved slot to this waiter.
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active -= 1
  }
}
