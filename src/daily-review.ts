import type { Context } from '@deepseek-ai/cordis'
import type { Companion } from './domain.js'
import { PartnerStore } from './store.js'
import { PartnerMemoryStore } from './memory-store.js'
import { MemoryReflectionService } from './memory-reflection.js'
import { PartnerAgentRuntime } from './agent-runtime.js'

const TICK_MS = 60_000

export class DailyReviewScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private readonly running = new Set<string>()

  constructor(private readonly ctx: Context, private readonly store: PartnerStore, private readonly memory: PartnerMemoryStore,
    private readonly reflection: MemoryReflectionService, private readonly agents: PartnerAgentRuntime, private readonly timeZone = 'Asia/Shanghai') {}

  start(): void { if (!this.closed && this.timer === undefined) this.schedule(5_000) }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined }

  async trigger(companionId: string, force = false): Promise<{ reviewed: number; failed: number; reason?: string }> {
    if (this.running.has(companionId)) return { reviewed: 0, failed: 0, reason: '每日终审正在执行' }
    const companion = this.store.snapshot().companions.find(item => item.id === companionId)
    if (!companion) throw new Error('伙伴不存在')
    if (!force && (!companion.automation.memory.enabled || !companion.automation.memory.dailyReviewEnabled)) return { reviewed: 0, failed: 0, reason: '每日终审未启用' }
    this.running.add(companionId)
    try { return await this.run(companion, force) } finally { this.running.delete(companionId) }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch(error => this.ctx.logger.error(`dsh-partner daily review tick failed: ${message(error)}`))
        .finally(() => { if (!this.closed) this.schedule(TICK_MS) })
    }, delay)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const companion of this.store.snapshot().companions) {
      if (!companion.automation.memory.enabled || !companion.automation.memory.dailyReviewEnabled) continue
      if (zonedHour(now, this.timeZone) < companion.automation.memory.dailyReviewHour) continue
      await this.trigger(companion.id).catch(error => this.ctx.logger.warn(`dsh-partner daily review for ${companion.id} failed: ${message(error)}`))
    }
  }

  private async run(companion: Companion, force: boolean): Promise<{ reviewed: number; failed: number; reason?: string }> {
    const date = force ? localDay(Date.now(), this.timeZone) : previousLocalDay(Date.now(), this.timeZone)
    const targets = await this.memory.pendingDailyReviews(companion.id, date, force ? Number.MAX_SAFE_INTEGER : Date.now())
    if (targets.length === 0) return { reviewed: 0, failed: 0, reason: '没有待终审的日期' }
    let reviewed = 0; let failed = 0
    for (const target of targets) {
      try {
        const created = await this.reflection.reviewDay(companion, target)
        if (created.length > 0) await this.agents.recordConcernCreatedNotice(companion, target.scopeId, created).catch(error => {
          this.ctx.logger.warn(`dsh-partner daily review concern notice failed: ${message(error)}`)
        })
        reviewed += 1
      }
      catch (error) { failed += 1; await this.memory.failDailyReview(target, message(error)); this.ctx.logger.warn(`dsh-partner daily review ${target.date} failed: ${message(error)}`) }
    }
    return { reviewed, failed }
  }
}

function previousLocalDay(now: number, timeZone: string): string {
  return localDay(now - 24 * 60 * 60_000, timeZone)
}
function localDay(now: number, timeZone: string): string { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) }
function zonedHour(now: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now))
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
