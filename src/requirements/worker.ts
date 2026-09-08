import type { PartnerStore } from '../store.js'
import type { BoardTask } from '../tasks/domain.js'
import type { BoardRequirement } from './domain.js'
import { RequirementService } from './service.js'
import { requirementIsIdle, requirementProgressKey } from './progress.js'
import { advanceRequirementRevision } from './revisions.js'

interface RequirementEffects {
  summarize(item: BoardRequirement, tasks: BoardTask[], signal: AbortSignal, stage?: boolean): Promise<string>
  deliver(item: BoardRequirement): Promise<void>
  warn(message: string): void
  isBusy?(companionId: string): boolean
}

/** One bounded worker. Durable state is the retry queue, not transient callbacks. */
export class RequirementWorker {
  private timer?: NodeJS.Timeout
  private job: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  private unsubscribe: (() => void) | undefined
  constructor(private readonly store: PartnerStore, private readonly service: RequirementService, private readonly effects: RequirementEffects) {}
  start(): void {
    this.closed = false
    this.timer = setInterval(() => { void this.tick() }, 5000); this.timer.unref?.()
    void this.tick()
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.job) return this.job
    this.job = this.run().catch(error => this.effects.warn(`需求处理失败：${String(error)}`)).finally(() => { this.job = undefined })
    return this.job
  }
  beginShutdown(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.controller?.abort(); this.unsubscribe?.() }
  async close(): Promise<void> { this.beginShutdown(); await this.job }
  private async run(): Promise<void> {
    const snapshot = this.store.snapshot()
    for (const item of snapshot.requirements ?? []) {
      if (this.closed) return
      if ((item.nextAttemptAt ?? 0) > Date.now()) continue
      const tasks = snapshot.tasks.filter(task => task.requirementId === item.id)
      const summarize = (item.status === 'active' || item.status === 'review') && tasks.length > 0 && tasks.every(task => task.status === 'done') && Boolean(item.ownerCompanionId) &&
        requirementIsIdle(snapshot, item) && !this.effects.isBusy?.(item.ownerCompanionId!)
      const stageKey = item.status !== 'done' && !summarize && Boolean(item.ownerCompanionId) &&
        Date.now() - item.updatedAt >= 15_000 && requirementIsIdle(snapshot, item) &&
        !this.effects.isBusy?.(item.ownerCompanionId!) ? requirementProgressKey(snapshot, item) : undefined
      const stage = stageKey !== undefined && item.reportBaselineKey !== stageKey &&
        !(item.stageReport?.key === stageKey && item.stageReport.notifiedAt)
      if (!summarize && !stage && !(item.status === 'done' && !item.notifiedAt)) continue
      let revision = item.revision
      try {
        let current = this.service.require(item.id)
        if (current.revision !== revision) continue
        if (stage) {
          const key = stageKey!
          this.controller = new AbortController()
          this.unsubscribe = this.store.subscribe(state => {
            const latest = state.requirements?.find(r => r.id === item.id)
            if (!latest || latest.revision !== revision || !requirementIsIdle(state, latest)) this.controller?.abort(new Error('需求已继续执行或调整'))
          }, () => {})
          if (current.stageReport?.key !== key) {
            const summary = await this.effects.summarize(current, tasks, this.controller.signal, true)
            this.controller.signal.throwIfAborted()
            if (!summary.trim()) throw new Error('阶段汇总为空，请重试')
            await this.store.update(state => {
              const latest = state.requirements?.find(r => r.id === item.id)
              if (!latest || latest.revision !== revision || !requirementIsIdle(state, latest)) throw new Error('需求已改变')
              latest.stageReport = { key, summary: summary.slice(0, 12000), createdAt: Date.now() }
            })
          }
          this.controller.signal.throwIfAborted()
          current = this.service.require(item.id)
          await this.effects.deliver(current)
          await this.store.update(state => {
            const latest = state.requirements?.find(r => r.id === item.id)
            if (latest?.revision === revision && latest.stageReport?.key === key) {
              latest.stageReport.notifiedAt = Date.now(); delete latest.lastError; delete latest.nextAttemptAt; delete latest.attempts
            }
          })
          continue
        }
        if (summarize) {
          await this.store.update(state => {
            const latest = state.requirements?.find(r => r.id === item.id)
            if (!latest || latest.revision !== revision || !['active', 'review'].includes(latest.status)) throw new Error('需求内容已改变')
            latest.status = 'review'; advanceRequirementRevision(latest); revision = latest.revision
          })
          current = this.service.require(item.id)
          this.controller = new AbortController()
          this.unsubscribe = this.store.subscribe(state => {
            const latest = state.requirements?.find(r => r.id === item.id)
            if (!latest || latest.revision !== revision) this.controller?.abort(new Error('需求已删除或调整'))
          }, () => {})
          const summary = await this.effects.summarize(current, tasks, this.controller.signal)
          this.controller.signal.throwIfAborted()
          this.unsubscribe(); this.unsubscribe = undefined
          current = await this.service.finish(item.id, revision, summary, { kind: 'companion', companionId: current.ownerCompanionId! })
          revision = current.revision
        }
        if (this.closed) return
        // Deletion or a new revision invalidates in-flight summary/delivery work.
        if (this.service.require(item.id).revision !== revision) continue
        await this.effects.deliver(current)
        await this.store.update(state => {
          const latest = state.requirements?.find(r => r.id === item.id)
          if (latest?.revision === revision && latest.status === 'done') { latest.notifiedAt = Date.now(); delete latest.lastError; delete latest.nextAttemptAt }
        })
      } catch (error) {
        if (this.closed) return
        await this.store.update(state => {
          const latest = state.requirements?.find(r => r.id === item.id)
          if (!latest || latest.revision !== revision) return
          latest.attempts = (latest.attempts ?? 0) + 1
          latest.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1200)
          latest.nextAttemptAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(latest.attempts, 6))
        })
      } finally { this.unsubscribe?.(); this.unsubscribe = undefined; this.controller = undefined }
    }
  }
}

export function requirementSummaryPrompt(item: BoardRequirement, tasks: BoardTask[], stage = false): string {
  const header = [
    stage
      ? '这是需求的阶段结果汇报，不是新任务，也不代表整个需求已完成。目前所有任务仅为已完成或受阻，没有尚未执行、执行中或待验收任务。汇总实际成果、文件/链接和关键结论；有受阻任务则说明阻塞原因及需要用户解决什么。验收意见、返工过程和内部交接内容不要发送给用户。可以后续继续追加任务。不要重新执行、创建任务或直接发送渠道消息；系统会持久化并投递本次汇总，不要求先归档。只根据实际交付说明，不把受阻写成完成。'
      : '这是需求整体收尾，不是新任务。以下子任务均已通过验收。只汇总最终成果、实际交付文件/链接、关键结论和仍需用户知道的限制。不要重新执行、创建任务或逐条播报验收过程；不要直接发送渠道消息，系统会保存本次最终回答、归档需求后统一发送。资料不足请明确说明，不编造结果。',
    `需求：${item.title}\n${item.description}`,
    `需求 ID：${item.id}；共 ${tasks.length} 项。以下为按任务均分预算的结果摘录，可能被截短；需要完整证据时按此需求查询看板，不要把摘录当成全部交付。`,
  ].join('\n\n')
  const budget = Math.max(1, Math.floor((60_000 - header.length - tasks.length * 2) / Math.max(1, tasks.length)))
  const rows = tasks.map((task, index) => {
    const title = `## ${index + 1}. ${task.title.slice(0, Math.min(80, Math.floor(budget / 3)))}${stage ? ` [${task.status}]` : ''}`
    const result = [task.resultAbstract, task.resultSummary].filter(Boolean).join('\n\n') || '未提供结果正文'
    return `${title}\n${result.slice(0, Math.min(4000, Math.max(0, budget - title.length - 1)))}`
  })
  return [header, ...rows].join('\n\n')
}
