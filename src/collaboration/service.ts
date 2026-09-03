import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { requiredText } from '../core/validation.js'
import type { Companion, CompanionAccessGrant } from '../domain.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import { parseTaskExecutionOutput } from '../tasks/result.js'
import { delegationKind, delegationPending, type PartnerDelegation, type PartnerDirectoryEntry } from './domain.js'
import { canRetryDelegation, delegationRetryDelay, retryDelayLabel } from './retry-policy.js'

const RECOVERY_TICK_MS = 5_000
const RECOVERY_CONCURRENCY = 3

interface PartnerSessionExecutor {
  execute(input: { sourceId: string; companion: Companion; prompt: string; parentSessionId?: string }): Promise<{ run: { id: string }; output: string }>
}

/** Owns durable partner work orchestration. Pending records are safe to reclaim after a process restart. */
export class PartnerCollaborationService {
  private sessionExecutor?: PartnerSessionExecutor
  private readonly active = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private started = false
  private closing = false
  private accessChangeNotifier?: (companionId: string) => Promise<void>

  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly executor: EphemeralExecutionService,
  ) {}

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
    this.timer = setInterval(() => { void this.tick() }, RECOVERY_TICK_MS)
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
  }

  directory(): PartnerDirectoryEntry[] {
    const state = this.store.snapshot()
    const running = new Set([
      ...state.executionRuns.filter(item => item.status === 'running').map(item => item.ownerCompanionId),
      ...state.delegations.filter(delegationPending).map(item => item.toCompanionId),
    ])
    return state.companions.map(companion => ({
      id: companion.id, name: companion.name, role: companion.role, description: companion.description,
      capabilities: companion.capabilities, enabledSkills: this.skills.bindings(companion.id, state).map(skill => ({ id: skill.id, name: skill.displayName })),
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
    const task = this.tasks.assertStartable(input.taskId)
    const from = input.initiatedBy === 'companion' ? this.requireCompanion(input.fromCompanionId ?? '') : undefined
    const to = this.resolveCompanion(input.to)
    if (from?.id === to.id) throw new Error('伙伴不能把任务委派给自己')
    if (from && !this.canAccess(from.id, to.id)) throw new Error(`伙伴「${from.name}」未获授权访问 @${to.name}`)
    const request = requiredText(input.request, 'request', 8000)
    const delegation: PartnerDelegation = {
      id: `delegation-${randomUUID()}`, kind: 'task', taskId: task.id, initiatedBy: input.initiatedBy,
      ...(from ? { fromCompanionId: from.id } : {}), toCompanionId: to.id, request, status: 'queued', attempts: 0, nextAttemptAt: Date.now() + 60_000,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}), createdAt: Date.now(),
    }
    await this.saveNew(delegation)
    try {
      const current = this.tasks.require(task.id)
      await this.tasks.update(task.id, { expectedRevision: current.revision, status: 'doing', assigneeCompanionId: to.id }, from ? { kind: 'companion', companionId: from.id } : { kind: 'user' })
      await this.mutate(delegation.id, item => { item.nextAttemptAt = Date.now() })
    } catch (error) {
      await this.cancel(delegation.id, `委派没有完成提交：${errorMessage(error)}`).catch(() => {})
      throw error
    }
    const claimed = await this.claim(delegation.id)
    if (claimed) this.launch(claimed)
    return structuredClone(claimed ?? delegation)
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
        const lostResult = delegationKind(item) === 'task' && item.status === 'canceled'
          && item.error?.includes('忽略旧执行结果') === true && task?.status === 'review' && !task.resultSummary
        if (lostResult && task) {
          task.status = 'doing'
          task.revision += 1
          task.updatedAt = now
          delete task.reviewSummary
          delete task.completedAt
          item.status = 'queued'
          item.nextAttemptAt = now
          item.error = '旧版协调器丢弃了提前进入待验收的执行结果，任务已重新进入恢复队列'
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

  private async tick(): Promise<void> {
    if (this.closing || this.active.size >= RECOVERY_CONCURRENCY) return
    const now = Date.now()
    const candidates = this.store.snapshot().delegations
      .filter(item => item.status === 'queued' && (item.nextAttemptAt ?? 0) <= now && !this.active.has(item.id))
      .sort((left, right) => (left.nextAttemptAt ?? left.createdAt) - (right.nextAttemptAt ?? right.createdAt))
      .slice(0, RECOVERY_CONCURRENCY - this.active.size)
    for (const candidate of candidates) {
      const claimed = await this.claim(candidate.id)
      if (claimed) this.launch(claimed)
    }
  }

  private async claim(id: string): Promise<PartnerDelegation | undefined> {
    let output: PartnerDelegation | undefined
    await this.store.update(state => {
      const item = state.delegations.find(value => value.id === id)
      if (!item || item.status !== 'queued' || (item.nextAttemptAt ?? 0) > Date.now()) return
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
    const promise = this.executeClaimed(delegation).catch(() => {}).finally(() => { this.active.delete(delegation.id) })
    this.active.set(delegation.id, promise)
  }

  private async executeClaimed(delegation: PartnerDelegation): Promise<void> {
    try {
      const task = this.tasks.require(delegation.taskId)
      const kind = delegationKind(delegation)
      if ((kind === 'task' && task.status !== 'doing') || (kind === 'review' && task.status !== 'review')) {
        await this.cancel(delegation.id, `任务状态已经变为 ${task.status}，不再恢复旧执行`)
        return
      }
      const to = this.requireCompanion(delegation.toCompanionId)
      const prompt = kind === 'review' ? reviewPrompt(task) : taskPrompt(task, delegation, to, this.optionalCompanion(delegation.fromCompanionId))
      const result = this.sessionExecutor
        ? await this.sessionExecutor.execute({
            sourceId: kind === 'review' ? `review:${task.id}:${delegation.id}` : delegation.id,
            companion: to, prompt, ...(delegation.parentSessionId ? { parentSessionId: delegation.parentSessionId } : {}),
          })
        : await this.executor.execute({
            kind: kind === 'review' ? 'review' : 'delegation', sourceId: delegation.id, companion: to, prompt,
            ...(delegation.parentSessionId ? { parentSessionId: delegation.parentSessionId } : {}), destroyAfterRun: true,
          })
      const latest = this.tasks.require(task.id)
      if (kind === 'review') {
        if (latest.status !== 'review') { await this.cancel(delegation.id, `任务状态已经变为 ${latest.status}，忽略旧验收结果`); return }
        await this.tasks.recordReview(task.id, result.output, { kind: 'companion', companionId: to.id })
      } else {
        if (latest.status !== 'doing' && latest.status !== 'review') { await this.cancel(delegation.id, `任务状态已经变为 ${latest.status}，忽略旧执行结果`); return }
        await this.tasks.completeExecution(task.id, parseTaskExecutionOutput(result.output), { kind: 'companion', companionId: to.id })
      }
      await this.complete(delegation.id, result.run.id, result.output)
    } catch (error) {
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
    const current = this.tasks.require(delegation.taskId)
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
    await this.store.update(state => { appendBounded(state.delegations, structuredClone(value), 500) })
  }

  private async mutate(id: string, change: (value: PartnerDelegation) => void): Promise<void> {
    await this.store.update(state => {
      const item = state.delegations.find(value => value.id === id)
      if (item) change(item)
    })
  }
}

function taskPrompt(task: ReturnType<TaskBoardService['require']>, delegation: PartnerDelegation, to: Companion, from?: Companion): string {
  const recovery = (delegation.attempts ?? 1) > 1
    ? `这是中断后的第 ${delegation.attempts} 次恢复执行。先检查工作目录、看板和外部目标中是否已有产出，避免重复写入、重复提交、重复发布或重复通知；已经完成的部分只需核验并汇报。`
    : ''
  return [
    from ? `你收到伙伴「${from.name}」委派的看板任务。` : '你收到用户从伙伴任务看板直接委派的任务。',
    `任务：${task.title}`,
    task.description ? `任务说明：${task.description}` : '',
    `委派要求：${delegation.request}`,
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
