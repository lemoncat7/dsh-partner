/** Separate ordered input preparation from long-running model replies. Queued
 * work stays unclaimed until execution; callers must not checkpoint past it. */
export class DirectDispatcher {
  private readonly lanes = new Map<string, { preparation: Promise<void>; jobs: Set<Promise<void>> }>()
  private readonly jobs = new Set<Promise<void>>()
  private readonly ids = new Set<string>()
  constructor(private readonly signal: AbortSignal, private readonly failed: (error: unknown) => void) {}
  get busy(): boolean { return this.jobs.size > 0 }
  has(id: string): boolean { return this.ids.has(id) }
  async waitForCapacity(): Promise<void> {
    while (this.jobs.size >= 100) {
      this.signal.throwIfAborted()
      await Promise.race(this.jobs)
    }
    this.signal.throwIfAborted()
  }
  enqueue(ids: string[], mode: 'queue' | 'steer', run: (prepared: () => void) => Promise<void>, laneKey = ''): void {
    this.signal.throwIfAborted()
    if (this.jobs.size >= 100) throw new Error('渠道待处理消息达到 100 组，请等待后重连；未处理消息不会跳过')
    let lane = this.lanes.get(laneKey)
    if (!lane) { lane = { preparation: Promise.resolve(), jobs: new Set() }; this.lanes.set(laneKey, lane) }
    const before = lane.preparation, older = [...lane.jobs]
    let release!: () => void
    lane.preparation = new Promise<void>(resolve => { release = resolve })
    ids.forEach(id => this.ids.add(id))
    const job = (async () => {
      await before
      if (mode === 'queue') await Promise.all(older)
      this.signal.throwIfAborted()
      await run(release)
    })().catch(error => { if (!this.signal.aborted) this.failed(error) }).finally(() => {
      release(); ids.forEach(id => this.ids.delete(id)); this.jobs.delete(job); lane.jobs.delete(job)
      if (!lane.jobs.size && this.lanes.get(laneKey) === lane) this.lanes.delete(laneKey)
    })
    this.jobs.add(job); lane.jobs.add(job)
  }
  async drain(): Promise<void> { await Promise.all(this.jobs) }
}
