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
  private readonly startedAt = Date.now()
  private readonly renewalStates = new Map<string, {state: string; detail: string; at: number}>()
  renewalStatus(id: string) { return this.renewalStates.get(id) }
  private renewalState(id: string, state: string, detail: string): void { this.renewalStates.set(id, {state, detail, at: Date.now()}) }
  private readonly running = new Set<string>()
  private readonly jobs = new Set<Promise<{ reviewed: number; failed: number; reason?: string }>>()

  constructor(private readonly ctx: Context, private readonly store: PartnerStore, private readonly memory: PartnerMemoryStore,
    private readonly reflection: MemoryReflectionService, private readonly agents: PartnerAgentRuntime, private readonly timeZone = 'Asia/Shanghai') {}

  start(): void { if (!this.closed && this.timer === undefined) this.schedule(5_000) }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined
    await Promise.allSettled([...this.jobs])
  }
  isRunning(id: string): boolean { return this.running.has(id) }

  async trigger(companionId: string, force = false, renewal = false): Promise<{ reviewed: number; failed: number; reason?: string }> {
    if (this.closed) return { reviewed: 0, failed: 0, reason: '记忆服务正在停止' }
    if (this.store.isCompanionRemoving(companionId)) return { reviewed: 0, failed: 0, reason: '伙伴正在删除' }
    if (this.running.has(companionId)) return { reviewed: 0, failed: 0, reason: '每日终审正在执行' }
    const companion = this.store.snapshot().companions.find(item => item.id === companionId)
    if (!companion) throw new Error('伙伴不存在')
    if(renewal && companion.automation.memory.rollingContextEnabled)return {reviewed:0,failed:0,reason:'滚动对话窗口已开启，暂停每日整段焕新'}
    if (!renewal && !force && (!companion.automation.memory.enabled || !companion.automation.memory.dailyReviewEnabled)) return { reviewed: 0, failed: 0, reason: '每日整理与焕新未启用' }
    this.running.add(companionId)
    const job = this.run(companion, force, renewal)
    this.jobs.add(job)
    try { return await job } finally { this.running.delete(companionId); this.jobs.delete(job) }
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
      const settings = companion.automation.memory
      if (settings.enabled && settings.dailyReviewEnabled && zonedHour(now, this.timeZone) >= settings.dailyReviewHour) {
        await this.trigger(companion.id).catch(error => this.ctx.logger.warn(`dsh-partner daily review failed: ${message(error)}`))
      }
      const hour = settings.contextRenewalHour ?? 4
      const crossedSchedule = localDay(now, this.timeZone) !== localDay(this.startedAt, this.timeZone) || zonedHour(this.startedAt, this.timeZone) < hour
      if (settings.rollingContextEnabled || settings.contextRenewalEnabled === false || zonedHour(now, this.timeZone) < hour || !crossedSchedule) continue
      const completed = await this.memory.renewalStatus(companion.id)
      const sessions = this.store.snapshot().sessions.filter(r => r.companionId === companion.id)
      if (sessions.length && sessions.every(r => completed.some(c => c.sessionId === r.sessionId && String(c.day) >= localDay(now, this.timeZone)))) continue
      await this.trigger(companion.id, false, true).catch(error => {
        this.renewalState(companion.id, 'retry', `焕新未完成，保留上下文并稍后重试：${message(error)}`)
        this.ctx.logger.warn(`dsh-partner context renewal failed: ${message(error)}`)
      })
    }
  }

  private async run(companion: Companion, force: boolean, renewal = false): Promise<{ reviewed: number; failed: number; reason?: string }> {
    if (renewal) {
      this.renewalState(companion.id, 'waiting', companion.automation.memory.enabled ? '等待记忆整理成功后焕新' : '等待当前回合结束后直接焕新')
      if (this.agents.isCompanionBusy(companion.id)) {
        this.renewalState(companion.id, 'waiting', '等待当前回合或记忆任务结束')
        return {reviewed:0,failed:0,reason:'等待当前回合或记忆任务结束'}
      }
      if (companion.automation.memory.enabled) await this.agents.prepareRenewalMemory(companion.id)
    }
    const date = force || renewal ? localDay(Date.now(), this.timeZone) : previousLocalDay(Date.now(), this.timeZone)
    const targets = companion.automation.memory.enabled && (force || renewal || companion.automation.memory.dailyReviewEnabled)
      ? await this.memory.pendingDailyReviews(companion.id, date, force ? Number.MAX_SAFE_INTEGER : Date.now()) : []

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
    if (renewal && failed === 0 && companion.automation.memory.contextRenewalEnabled !== false) {
      const count = await this.agents.renewReviewedContexts(companion.id, localDay(Date.now(), this.timeZone))
      this.renewalState(companion.id, count ? 'completed' : 'waiting', count ? `已焕新 ${count} 个会话` : '等待待处理记忆、完整归档或空闲会话；原上下文保留')
    } else if (renewal && failed) this.renewalState(companion.id, 'retry', '记忆整理未成功，保留上下文并稍后重试')
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
