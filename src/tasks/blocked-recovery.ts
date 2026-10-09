import type { PartnerStore } from '../store.js'
import type { PartnerState } from '../domain.js'
import type { BoardTask } from './domain.js'
import { taskWorkContext } from './context.js'

export function recoveryOwners(state: PartnerState, task: BoardTask): string[] {
  const owner = state.requirements?.find(r => r.id === task.requirementId)?.ownerCompanionId
  return [...new Set([task.creatorCompanionId, owner].filter((id): id is string => Boolean(id)))]
    .filter(id => state.companions.some(c => c.id === id))
}

export function recoveryPending(state: PartnerState, task: BoardTask): boolean {
  if (task.status !== 'blocked') return false
  const recovery = task.blockedRecovery
  if (recovery?.needsUser) return false
  return recoveryOwners(state, task).some(id => !recovery?.handledBy.includes(id))
}

interface Effects {
  execute(owner: string, task: BoardTask, prompt: string, signal: AbortSignal): Promise<string>
  isBusy(owner: string): boolean
  warn(message: string): void
}

/** Durable bounded remediation; never replays the failed executor blindly. */
export class BlockedTaskRecovery {
  private timer?: NodeJS.Timeout
  private job: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  constructor(private readonly store: PartnerStore, private readonly effects: Effects) {}
  start(): void {
    this.timer = setInterval(() => { void this.tick() }, 5000); this.timer.unref?.()
    void this.tick()
  }
  beginShutdown(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.controller?.abort() }
  async close(): Promise<void> { this.beginShutdown(); await this.job }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return this.job ??= this.run().catch(e => this.effects.warn(`受阻恢复失败：${String(e)}`)).finally(() => { this.job = undefined })
  }
  private async run(): Promise<void> {
    const state = this.store.snapshot()
    for (const task of state.tasks) {
      if (!recoveryPending(state, task) || (task.blockedRecovery?.nextAttemptAt ?? 0) > Date.now()) continue
      const owner = recoveryOwners(state, task).find(id => !task.blockedRecovery?.handledBy.includes(id))!
      if (this.effects.isBusy(owner) || state.delegations.some(d => d.taskId === task.id && ['queued', 'running'].includes(d.status))) continue
      let claimed = false
      await this.store.update(draft => {
        const current = draft.tasks.find(t => t.id === task.id)
        if (!current || current.status !== 'blocked' || current.revision !== task.revision) return
        const recovery = current.blockedRecovery ??= { workRevision: current.workRevision ?? 1, handledBy: [], attempts: 0 }
        if (recovery.needsUser || recovery.handledBy.includes(owner)) return
        recovery.running = owner; recovery.attempts++; claimed = true
      })
      if (!claimed) continue
      const controller = this.controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('受阻协调超时')), 10 * 60_000)
      const unsubscribe = this.store.subscribe(next => {
        if (!next.tasks.some(t => t.id === task.id && t.status === 'blocked' && (t.workRevision ?? 1) === (task.workRevision ?? 1))) controller.abort()
      }, () => {})
      let summary = '', failed = false
      try {
        summary = await this.effects.execute(owner, task, [
          '这是受阻任务的内部协调，不是新需求，不直接发送渠道消息，也不要创建关注或轮询定时任务。',
          owner === task.creatorCompanionId ? '你是任务创建者，先负责排查和解除阻塞。' : '创建者未能解除阻塞，你是需求负责人，负责最后协调；确有歧义、缺授权或无法解决时明确给出用户需要决定的问题。',
          '先查询最新看板和已有文件/外部任务，保留真实产出。不重新生成已有结果、不原样无限重试、不扩大权限。能修复则调整原任务并显式 status=ready、autoRun=true 恢复；不能修复则保持 blocked，在最终答复写明已尝试的方法、具体原因和所需输入，系统会升级给需求负责人统一通知。不要仅口头说已恢复。',
          `任务 ID：${task.id}；任务：${task.title}；当前版本：${task.revision}`,
          taskWorkContext(state, task),
          `阻塞原因：${task.rejectionReason ?? task.resultSummary ?? '请查看最近执行记录'}`,
          task.blockedRecovery?.summary ? `上一步协调：${task.blockedRecovery.summary}` : '',
        ].filter(Boolean).join('\n\n'), controller.signal)
      } catch (error) { failed = true; summary = `内部协调未完成：${error instanceof Error ? error.message : String(error)}` }
      finally { clearTimeout(timeout); unsubscribe(); this.controller = undefined }
      if (this.closed) return
      await this.store.update(draft => {
        const current = draft.tasks.find(t => t.id === task.id), recovery = current?.blockedRecovery
        if (!current || !recovery || recovery.running !== owner) return
        delete recovery.running
        recovery.summary = summary.slice(0, 3000)
        if (failed && current.status === 'blocked' && recovery.attempts < 3) { recovery.nextAttemptAt = Date.now() + 60_000; return }
        if (!recovery.handledBy.includes(owner)) recovery.handledBy.push(owner)
        delete recovery.nextAttemptAt
        recovery.needsUser = current.status === 'blocked' && recoveryOwners(draft, current).every(id => recovery.handledBy.includes(id))
      })
      return
    }
  }
}
