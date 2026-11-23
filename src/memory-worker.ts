import type { Companion } from './domain.js'
import type { PartnerConcern } from './concern-domain.js'

interface MemoryWorkerPorts {
  companions(): Companion[]
  removing(id: string): boolean
  process(companion: Companion): Promise<{ scopeId: string; created: PartnerConcern[] } | undefined>
  warn(message: string): void
}

/** Bounded global concurrency (one), no model work on the chat event path. */
export class MemoryWorker {
  private timer: ReturnType<typeof setTimeout> | undefined
  private current: Promise<void> | undefined
  private closed = false
  private idleRounds = 0
  private awakened = false
  constructor(private readonly ports: MemoryWorkerPorts) {}
  start(): void { if (!this.closed && !this.timer && !this.current) this.schedule(1_000) }
  wake(): void {
    if (this.closed) return
    this.idleRounds = 0
    this.awakened = true
    if (this.current) return
    if (this.timer) clearTimeout(this.timer)
    this.schedule(1_000)
  }
  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.current
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.awakened = false
      this.current = this.tick().finally(() => {
        this.current = undefined
        if (!this.closed) this.schedule(this.awakened ? 1_000 : Math.min(30_000, 5_000 * 2 ** Math.min(this.idleRounds, 3)))
      })
    }, delay)
    this.timer.unref?.()
  }
  async tick(): Promise<void> {
    let worked = false
    for (const companion of this.ports.companions()) {
      if (this.closed) break
      if (!companion.automation.memory.enabled || this.ports.removing(companion.id)) continue
      try {
        if (await this.ports.process(companion)) worked = true
      } catch (error) { worked = true; this.ports.warn(`memory background processing failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    this.idleRounds = worked ? 0 : this.idleRounds + 1
  }
}
