import { randomUUID } from 'node:crypto'
import { requiredText } from '../core/validation.js'
import type { Companion, CompanionAccessGrant } from '../domain.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import { parseTaskExecutionOutput } from '../tasks/result.js'
import { delegationKind, delegationPending, type PartnerDelegation, type PartnerDirectoryEntry } from './domain.js'
import { canRetryDelegation, delegationRetryDelay, retryDelayLabel } from './retry-policy.js'
import { appendDelegation, autoRunCandidates, pendingTaskDelegation, taskDelegation, taskDependenciesDone, taskDispatchDenied } from './task-dispatch.js'
import { TaskWorkflowError } from '../tasks/workflow-error.js'
import { preserveTaskAttempt, taskWorkContext } from '../tasks/context.js'
import { TaskConflictError } from '../tasks/service.js'
import { repairableReviewCancellation, unfinishedReview } from './task-recovery.js'

const RECOVERY_TICK_MS = 5_000
const RECOVERY_CONCURRENCY = 3

interface PartnerSessionExecutor {
  execute(input: { sourceId: string; companion: Companion; prompt: string; parentSessionId?: string; signal?: AbortSignal }): Promise<{ run: { id: string }; output: string }>
}

/** Owns durable partner work orchestration. Pending records are safe to reclaim after a process restart. */
export class PartnerCollaborationService {
  private sessionExecutor?: PartnerSessionExecutor
  private readonly active = new Map<string, Promise<void>>()
  private readonly cancellations = new Map<string, { taskId: string; controller: AbortController }>()
  private timer: NodeJS.Timeout | undefined
  private started = false
  private closing = false
  private accessChangeNotifier?: (companionId: string) => Promise<void>
  private ticking: Promise<void> | undefined
  private readonly stopWorkObserver: () => void

  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly executor: EphemeralExecutionService,
  ) { tasks.setRemovalNotifier(ids => {
    for (const entry of this.cancellations.values()) if (ids.includes(entry.taskId)) entry.controller.abort(new Error('任务已删除'))
  })
    this.stopWorkObserver = store.subscribe(state => {
      for (const [id, entry] of this.cancellations) {
        if (!state.delegations.some(d => d.id === id && d.status === 'running')) entry.controller.abort(new Error('任务执行已取消或被新版本替代'))
      }
    }, () => {})
  }

  setSessionExecutor(executor: PartnerSessionExecutor): void {
    this.sessionExecutor = executor
  }

  setAccessChangeNotifier(notifier: (companionId: string) => Promise<void>): void {
    this.accessChangeNotifier = notifier
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.closing = false
    await this.reconcileInterruptedWork()
    await this.tick()
    this.timer = setInterval(() => { void this.tick().catch(() => { /* Durable intent remains available for the next tick. */ }) }, RECOVERY_TICK_MS)
    this.timer.unref?.()
  }

  beginShutdown(): void {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async close(): Promise<void> {
    this.beginShutdown()
    await Promise.allSettled([...this.active.values()])
    this.active.clear()
    this.stopWorkObserver()
  }

  directory(): PartnerDirectoryEntry[] {
    const state = this.store.snapshot()
    const running = new Set([
      ...state.executionRuns.filter(item => item.status === 'running').map(item => item.ownerCompanionId),
      ...state.delegations.filter(delegationPending).map(item => item.toCompanionId),
    ])
    return state.companions.map(companion => ({
      id: companion.id, name: companion.name, role: companion.role, description: companion.description,
      capabilities: companion.capabilities,
      enabledSkills: companion.capabilities.includes('skills')
        ? this.skills.bindings(companion.id, state).map(skill => ({ id: skill.id, name: skill.displayName })) : [],
      availability: running.has(companion.id) ? 'busy' : 'available',
    }))
  }

  directoryFor(companionId: string): PartnerDirectoryEntry[] {
    this.requireCompanion(companionId)
    const allowed = new Set(this.store.snapshot().companionAccessGrants.filter(grant => grant.fromCompanionId === companionId).map(grant => grant.toCompanionId))
    return this.directory().filter(entry => allowed.has(entry.id))
  }

  accessTargetIds(companionId: string): string[] {
    this.requireCompanion(companionId)
    return this.store.snapshot().companionAccessGrants.filter(grant => grant.fromCompanionId === companionId).map(grant => grant.toCompanionId)
  }

  accessGrants(): CompanionAccessGrant[] {
    return this.store.snapshot().companionAccessGrants
  }

  canAccess(fromCompanionId: string, toCompanionId: string): boolean {
    return this.store.snapshot().companionAccessGrants.some(grant => grant.fromCompanionId === fromCompanionId && grant.toCompanionId === toCompanionId)
  }

  async replaceAccessTargets(fromCompanionId: string, targetIds: string[]): Promise<string[]> {
    this.requireCompanion(fromCompanionId)
    const unique = [...new Set(targetIds)]
    if (unique.includes(fromCompanionId)) throw new Error('伙伴不能授权访问自己')
    const state = this.store.snapshot()
    if (unique.length > Math.min(100, state.companions.length - 1)) throw new Error('伙伴授权数量超出限制')
    for (const id of unique) if (!state.companions.some(companion => companion.id === id)) throw new Error(`伙伴 ${id} 不存在`)
    const now = Date.now()
    await this.store.update(draft => {
      const previous = new Map(draft.companionAccessGrants.filter(grant => grant.fromCompanionId === fromCompanionId).map(grant => [grant.toCompanionId, grant]))
      draft.companionAccessGrants = draft.companionAccessGrants.filter(grant => grant.fromCompanionId !== fromCompanionId)
      draft.companionAccessGrants.push(...unique.map(toCompanionId => previous.get(toCompanionId) ?? { fromCompanionId, toCompanionId, createdAt: now }))
    })
    return unique
  }

  /** Persist one directed access roster and recompose the grantee atomically. */
  async updateAccessTargets(fromCompanionId: string, targetIds: string[]): Promise<string[]> {
    const previous = this.accessTargetIds(fromCompanionId)
    const next = await this.replaceAccessTargets(fromCompanionId, targetIds)
    try {
      await this.accessChangeNotifier?.(fromCompanionId)
      return next
    } catch (error) {
      await this.replaceAccessTargets(fromCompanionId, previous)
      await this.accessChangeNotifier?.(fromCompanionId).catch(() => {})
      throw error
    }
  }

  resolveCompanion(reference: string): Companion {
    const normalized = reference.trim().replace(/^@/, '').toLocaleLowerCase()
    const matches = this.store.snapshot().companions.filter(item => item.id.toLocaleLowerCase() === normalized || item.name.toLocaleLowerCase() === normalized)
    if (matches.length === 0) throw new Error(`找不到伙伴 ${reference}`)
    if (matches.length > 1) throw new Error(`伙伴名称 ${reference} 不唯一，请使用伙伴 id`)
    return matches[0]!
  }

  async delegate(input: { taskId: string; initiatedBy: 'user' | 'companion'; fromCompanionId?: string; to: string; request: string; parentSessionId?: string }): Promise<PartnerDelegation> {
    const from = input.initiatedBy === 'companion' ? this.requireCompanion(input.fromCompanionId ?? '') : undefined
    const to = this.resolveCompanion(input.to)
    if (from && from.id !== to.id && !this.canAccess(from.id, to.id)) throw new Error(`伙伴「${from.name}」未获授权访问 @${to.name}`)
    const request = requiredText(input.request, 'request', 8000)
    let delegation!: PartnerDelegation
    // Task assignment and durable queue entry commit together. Repeated calls
    // return the existing job instead of launching duplicate work.
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === input.taskId)
      if (!task) throw new Error('Task does not exist')
      const pending = pendingTaskDelegation(state, task.id)
      if (pending) {
        if (pending.toCompanionId !== to.id) throw new TaskWorkflowError('TASK_ALREADY_DELEGATED', '任务已提交给其他伙伴，请先处理已有执行',
          { taskId: task.id, expectedRevision: task.revision, delegationId: pending.id, assigneeCompanionId: pending.toCompanionId, status: pending.status },
          '不要把当前正在执行的任务再次转派。当前执行者缺工具或需要拆分时使用 partner_task_board request_replan 后结束本轮；需求负责人随后 update 分工并显式 autoRun=true 恢复。')
        delegation = structuredClone(pending); return
      }
      if (['doing', 'review', 'done'].includes(task.status)) throw new Error('任务已经在执行、待验收或已完成，不能重复提交')
      if (task.replanRequested) throw new TaskWorkflowError('TASK_REPLAN_REQUIRED', '任务已暂停等待重规划', { taskId: task.id, expectedRevision: task.revision }, '需求负责人或用户先 update 调整任务，再明确 autoRun=true 恢复；不要重复 delegate。')
      delegation = taskDelegation(task, { ...input, to: to.id, request })
      const denied = taskDispatchDenied(state, delegation)
      if (denied) throw new Error(denied)
      appendDelegation(state, delegation)
      task.status = 'ready'; task.assigneeCompanionId = to.id
      task.revision += 1; task.updatedAt = Date.now()
    })
    const claimed = await this.claim(delegation.id)
    if (claimed) this.launch(claimed)
    return structuredClone(claimed ?? this.store.snapshot().delegations.find(item => item.id === delegation.id) ?? delegation)
  }

  async reviewTask(input: { taskId: string; to: string }): Promise<{ accepted: true }> {
    const task = this.tasks.require(input.taskId)
    if (task.status !== 'review') throw new Error('只有待验收任务可以交给伙伴核验')
    if (this.store.snapshot().delegations.some(item => delegationKind(item) === 'review' && item.taskId === task.id && delegationPending(item))) throw new Error('这个任务正在核验中')
    const reviewer = this.resolveCompanion(input.to)
    if (task.reviewerCompanionId && task.reviewerCompanionId !== reviewer.id) throw new Error('请选择任务中指定的验收伙伴')
    if (!task.reviewerCompanionId) await this.tasks.update(task.id, { expectedRevision: task.revision, reviewerCompanionId: reviewer.id }, { kind: 'user' })
    const delegation: PartnerDelegation = {
      id: `delegation-${randomUUID()}`, kind: 'review', taskId: task.id, initiatedBy: 'user', toCompanionId: reviewer.id,
      request: `核验看板任务：${task.title}`, status: 'queued', attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now(),
    }
    await this.saveNew(delegation)
    const claimed = await this.claim(delegation.id)
    if (claimed) this.launch(claimed)
    return { accepted: true }
  }

  private async reconcileInterruptedWork(): Promise<void> {
    const recovered: Array<{ taskId: string; kind: 'task' | 'review'; repairedLostResult?: boolean }> = []
    const now = Date.now()
    await this.store.update(state => {
      for (const item of state.delegations) {
        const task = state.tasks.find(value => value.id === item.taskId)
        const lostResult = task && repairableReviewCancellation(state, task, item)
        if (lostResult && task) {
          item.status = 'queued'
          item.nextAttemptAt = now
          item.error = '旧版协调器取消了尚未保存执行结果的待验收任务，已重新进入恢复队列'
          delete item.completedAt
          recovered.push({ taskId: item.taskId, kind: 'task', repairedLostResult: true })
          continue
        }
        if (item.status !== 'running') continue
        item.status = 'queued'
        item.attempts = Math.max(1, item.attempts ?? 0)
        item.nextAttemptAt = now
        item.error = 'DSH 服务或执行进程中断，任务已进入恢复队列'
        delete item.completedAt
        recovered.push({ taskId: item.taskId, kind: delegationKind(item) })
      }
    })
    for (const item of recovered) await this.tasks.recordRecovery(
      item.taskId,
      item.repairedLostResult ? '检测到旧版协调器未保存执行结果，已重新接管任务' : item.kind === 'review' ? '服务恢复后已重新接管未完成的伙伴验收' : '服务恢复后已重新接管未完成的伙伴任务',
      false,
    )
  }

  /** Also used after a tool creates an assigned task; never awaits execution. */
  async dispatchReadyTasks(): Promise<void> { await this.tick() }

  private tick(): Promise<void> {
    if (this.ticking) return this.ticking
    const job = this.dispatchTick().finally(() => { if (this.ticking === job) this.ticking = undefined })
    this.ticking = job
    return job
  }

  private async dispatchTick(): Promise<void> {
    if (this.closing || this.active.size >= RECOVERY_CONCURRENCY) return
    // Only explicit new submission intent is scanned. Legacy ready tasks and
    // planning-only backlog records never start as a side effect of upgrading.
    if (autoRunCandidates(this.store.snapshot()).length) await this.store.update(state => {
      for (const task of autoRunCandidates(state)) {
        appendDelegation(state, taskDelegation(task, {
          initiatedBy: task.creatorCompanionId ? 'companion' : 'user',
          ...(task.creatorCompanionId ? { fromCompanionId: task.creatorCompanionId } : {}),
          to: task.assigneeCompanionId!, request: task.description || task.title,
          ...(task.creatorSessionId ? { parentSessionId: task.creatorSessionId } : {}),
        }))
      }
    })
    const now = Date.now()
    const snapshot = this.store.snapshot()
    const candidates = snapshot.delegations
      .filter(item => item.status === 'queued' && (item.nextAttemptAt ?? 0) <= now && !this.active.has(item.id))
      .filter(item => {
        const task = snapshot.tasks.find(task => task.id === item.taskId)
        return !task || taskDispatchDenied(snapshot, item) || delegationKind(item) === 'review' || task.status !== 'ready' || taskDependenciesDone(task, snapshot.tasks)
      })
      .sort((left, right) => (left.nextAttemptAt ?? left.createdAt) - (right.nextAttemptAt ?? right.createdAt))
      .slice(0, RECOVERY_CONCURRENCY - this.active.size)
    for (const candidate of candidates) {
      const claimed = await this.claim(candidate.id)
      if (claimed) this.launch(claimed)
    }
  }

  private async claim(id: string): Promise<PartnerDelegation | undefined> {
    if (this.closing) return undefined
    let output: PartnerDelegation | undefined
    await this.store.update(state => {
      const item = state.delegations.find(value => value.id === id)
      if (!item || item.status !== 'queued' || (item.nextAttemptAt ?? 0) > Date.now()) return
      if (this.store.isCompanionRemoving(item.toCompanionId) || (item.fromCompanionId && this.store.isCompanionRemoving(item.fromCompanionId))) return
      const task = state.tasks.find(task => task.id === item.taskId)
      const denied = taskDispatchDenied(state, item)
      const taskWork = delegationKind(item) === 'task'
      const resumeReview = task && unfinishedReview(task, item)
      if (!task || denied || (taskWork ? (!['ready', 'doing'].includes(task.status) && !resumeReview) || (task.assigneeCompanionId !== item.toCompanionId && (task.assigneeCompanionId || !item.attempts)) : task.status !== 'review' || (task.reviewerCompanionId && task.reviewerCompanionId !== item.toCompanionId))) {
        item.status = 'canceled'; item.error = denied ?? '任务或负责人已改变，取消旧执行'; item.completedAt = Date.now()
        delete item.nextAttemptAt
        if (task && denied && task.status === 'ready') {
          task.status = 'blocked'; task.resultSummary = denied; task.updatedAt = Date.now(); task.revision += 1
        }
        return
      }
      if (taskWork && !taskDependenciesDone(task, state.tasks)) return
      if (state.delegations.filter(value => value.status === 'running').length >= RECOVERY_CONCURRENCY) return
      if (taskWork && (task.status === 'ready' || resumeReview)) {
        preserveTaskAttempt(task)
        task.status = 'doing'; task.updatedAt = Date.now(); task.revision += 1
        delete task.resultAbstract; delete task.resultSummary; delete task.reviewSummary; delete task.reviewHandoff
      }
      const now = Date.now()
      item.status = 'running'
      item.attempts = (item.attempts ?? 0) + 1
      item.lastAttemptAt = now
      item.startedAt ??= now
      delete item.nextAttemptAt
      delete item.completedAt
      output = structuredClone(item)
    })
    return output
  }

  private launch(delegation: PartnerDelegation): void {
    if (this.active.has(delegation.id)) return
    const controller = new AbortController()
    this.cancellations.set(delegation.id, { taskId: delegation.taskId, controller })
    const promise = this.executeClaimed(delegation, controller.signal).catch(() => {}).finally(() => { this.active.delete(delegation.id); this.cancellations.delete(delegation.id) })
    this.active.set(delegation.id, promise)
  }

  private async executeClaimed(delegation: PartnerDelegation, signal: AbortSignal): Promise<void> {
    try {
      const task = this.tasks.require(delegation.taskId)
      const kind = delegationKind(delegation)
      if ((kind === 'task' && task.status !== 'doing') || (kind === 'review' && task.status !== 'review')) {
        await this.cancel(delegation.id, `任务状态已经变为 ${task.status}，不再恢复旧执行`)
        return
      }
      const to = this.requireCompanion(delegation.toCompanionId)
      const denied = taskDispatchDenied(this.store.snapshot(), delegation)
      if (denied) throw new Error(denied)
      const prerequisiteResults = this.tasks.snapshot().tasks.filter(item => task.dependencyTaskIds.includes(item.id))
        .map(item => `- ${item.title}（${item.id}）：${(item.resultSummary || item.resultAbstract || '没有可见交付物，请先核对看板记录').slice(0, 1800)}`).join('\n').slice(0, 10_000)
      const context = taskWorkContext(this.store.snapshot(), task)
      const prompt = kind === 'review' ? reviewPrompt(task) + '\n\n' + context : taskPrompt(task, delegation, to, this.optionalCompanion(delegation.fromCompanionId), prerequisiteResults) + '\n\n' + context
      const result = this.sessionExecutor
        ? await this.sessionExecutor.execute({
            sourceId: kind === 'review' ? `review:${task.id}:${delegation.id}` : delegation.id,
            companion: to, prompt, signal, ...(delegation.parentSessionId ? { parentSessionId: delegation.parentSessionId } : {}),
          })
        : await this.executor.execute({
            kind: kind === 'review' ? 'review' : 'delegation', sourceId: delegation.id, companion: to, prompt, signal,
            ...(delegation.parentSessionId ? { parentSessionId: delegation.parentSessionId } : {}), destroyAfterRun: true,
          })
      if (signal.aborted || !this.store.snapshot().delegations.some(d => d.id === delegation.id && d.status === 'running')) return
      const latest = this.tasks.require(task.id)
      if (kind === 'review') {
        if (latest.status !== 'review') { await this.cancel(delegation.id, `任务状态已经变为 ${latest.status}，忽略旧验收结果`); return }
        if (latest.revision !== task.revision) { await this.cancel(delegation.id, '核验期间任务已更新，忽略旧意见；请重新核验最新版本'); return }
        await this.tasks.recordReview(task.id, result.output, { kind: 'companion', companionId: to.id }, task.revision)
      } else {
        if (latest.status !== 'doing' && latest.status !== 'review') { await this.cancel(delegation.id, `任务状态已经变为 ${latest.status}，忽略旧执行结果`); return }
        await this.tasks.completeExecution(task.id, parseTaskExecutionOutput(result.output), { kind: 'companion', companionId: to.id }, task.workRevision ?? 1)
      }
      await this.complete(delegation.id, result.run.id, result.output)
    } catch (error) {
      if (signal.aborted || !this.store.snapshot().tasks.some(t => t.id === delegation.taskId) || !this.store.snapshot().delegations.some(d => d.id === delegation.id && d.status === 'running')) return
      if (error instanceof TaskConflictError) { await this.cancel(delegation.id, '任务版本已更新，忽略旧执行/核验结论'); return }
      if (this.closing) await this.retry(delegation, error, true)
      else if (canRetryDelegation(error, delegation.attempts ?? 1)) await this.retry(delegation, error, false)
      else await this.fail(delegation, error)
    }
  }

  private async retry(delegation: PartnerDelegation, error: unknown, immediate: boolean): Promise<void> {
    const message = errorMessage(error)
    const delay = immediate ? 0 : delegationRetryDelay(delegation.attempts ?? 1)
    const nextAttemptAt = Date.now() + delay
    await this.mutate(delegation.id, item => {
      item.status = 'queued'; item.nextAttemptAt = nextAttemptAt; item.error = message; delete item.completedAt
    })
    await this.tasks.recordRecovery(
      delegation.taskId,
      immediate ? '服务正在停止，执行已安全放回恢复队列' : `执行环境暂时不可用，将在约 ${retryDelayLabel(delay)}后自动重试（第 ${delegation.attempts ?? 1} 次失败）`,
      true,
    )
  }

  private async complete(id: string, runId: string, output: string): Promise<void> {
    await this.mutate(id, item => {
      item.status = 'completed'; item.completedAt = Date.now(); item.executionRunId = runId; item.resultSummary = output.slice(0, 2400)
      delete item.nextAttemptAt; delete item.error
    })
  }

  private async cancel(id: string, reason: string): Promise<void> {
    await this.mutate(id, item => { item.status = 'canceled'; item.completedAt = Date.now(); item.error = reason; delete item.nextAttemptAt })
  }

  private async fail(delegation: PartnerDelegation, error: unknown): Promise<void> {
    const reason = errorMessage(error)
    await this.mutate(delegation.id, item => { item.status = 'failed'; item.completedAt = Date.now(); item.error = reason; delete item.nextAttemptAt })
    const current = this.store.snapshot().tasks.find(t => t.id === delegation.taskId)
    if (!current) return
    if (delegationKind(delegation) === 'task') {
      if (current.status === 'doing') await this.tasks.failExecution(current.id, reason, { kind: 'companion', companionId: delegation.toCompanionId }).catch(() => {})
    } else if (current.status === 'review') {
      await this.tasks.comment(current.id, `验收执行失败：${reason}`, { kind: 'companion', companionId: delegation.toCompanionId }).catch(() => {})
    }
  }

  private requireCompanion(id: string): Companion {
    const companion = this.store.snapshot().companions.find(item => item.id === id)
    if (!companion) throw new Error('Companion does not exist')
    return companion
  }

  private optionalCompanion(id: string | undefined): Companion | undefined {
    return id ? this.store.snapshot().companions.find(item => item.id === id) : undefined
  }

  private async saveNew(value: PartnerDelegation): Promise<void> {
    await this.store.update(state => { appendDelegation(state, structuredClone(value)) })
  }

  private async mutate(id: string, change: (value: PartnerDelegation) => void): Promise<void> {
    await this.store.update(state => {
      const item = state.delegations.find(value => value.id === id)
      if (item) change(item)
    })
  }
}

function taskPrompt(task: ReturnType<TaskBoardService['require']>, delegation: PartnerDelegation, to: Companion, from?: Companion, prerequisiteResults?: string): string {
  const recovery = (delegation.attempts ?? 1) > 1
    ? `这是中断后的第 ${delegation.attempts} 次恢复执行。先检查工作目录、看板和外部目标中是否已有产出，避免重复写入、重复提交、重复发布或重复通知；已经完成的部分只需核验并汇报。`
    : ''
  return [
    from ? `你收到伙伴「${from.name}」委派的看板任务。` : '你收到用户从伙伴任务看板直接委派的任务。',
    `任务：${task.title}`,
    `看板任务 id：${task.id}。这是已经分配给你的具体阶段，请在该范围内完成交付，不要重复创建同名任务或仅回复分工计划。`,
    '你是本任务执行者，不一定是需求负责人。缺少真实执行工具或需要换人、拆分时，用 partner_task_board request_replan 携带当前 taskId、expectedRevision、message 交回负责人，然后停止本轮；不得把正在执行的本任务再次 delegate，不得直接修改插件 JSON 绕过工具权限。',
    task.description ? `任务说明：${task.description}` : '',
    prerequisiteResults ? `已验收前置任务的公开产出：\n${prerequisiteResults}` : '',
    `最初委派要求（历史快照；若后附最新需求、任务说明或打回理由与其不同，以最新要求为准）：${delegation.request}`,
    '交付摘要只写用户需要的实际结论，不要包含“已提交 review”“等待验收”“调用 accept”等内部流程状态。',
    recovery,
    `当前执行伙伴：${to.name}。请真正完成能够完成的工作。最终回复必须用下面三个标签分离渠道摘要、完整交付物和内部验收交接：\n<partner-summary>\n一至三句可直接发给用户的短结论\n</partner-summary>\n<partner-deliverable>\n只写用户最终需要的产出、证据、来源和必要限制\n</partner-deliverable>\n<partner-review-handoff>\n只写给验收者的核验点、待确认项与风险\n</partner-review-handoff>\n不要访问其他伙伴的私有会话或记忆。`,
  ].filter(Boolean).join('\n\n')
}

function reviewPrompt(task: ReturnType<TaskBoardService['require']>): string {
  return [
    '你收到一个伙伴看板任务的独立验收请求。请根据任务要求和执行结果核验真实性、完整性与可复现性。',
    `任务：${task.title}`,
    task.description ? `任务说明：${task.description}` : '',
    task.resultSummary ? `执行结果：\n${task.resultSummary}` : '执行者没有提交可见结果，请明确指出。',
    task.reviewHandoff ? `执行者验收交接：\n${task.reviewHandoff}` : '',
    '请输出：验收结论建议（通过或打回）、核验证据、缺失项，以及若打回应如何修正。你只提供核验意见，最终通过或打回由用户决定。',
  ].filter(Boolean).join('\n\n')
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
