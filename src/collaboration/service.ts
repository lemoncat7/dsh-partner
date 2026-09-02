import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { requiredText } from '../core/validation.js'
import type { Companion } from '../domain.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import type { PartnerDelegation, PartnerDirectoryEntry } from './domain.js'

interface PartnerSessionExecutor {
  execute(input: { sourceId: string; companion: Companion; prompt: string; parentSessionId?: string }): Promise<{ run: { id: string }; output: string }>
}

export class PartnerCollaborationService {
  private readonly activeReviews = new Set<string>()
  private sessionExecutor?: PartnerSessionExecutor

  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly executor: EphemeralExecutionService,
  ) {}

  setSessionExecutor(executor: PartnerSessionExecutor): void {
    this.sessionExecutor = executor
  }

  directory(): PartnerDirectoryEntry[] {
    const state = this.store.snapshot()
    const running = new Set(state.executionRuns.filter(item => item.status === 'running').map(item => item.ownerCompanionId))
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
    const now = Date.now()
    const delegation: PartnerDelegation = {
      id: `delegation-${randomUUID()}`, taskId: task.id, initiatedBy: input.initiatedBy,
      ...(from ? { fromCompanionId: from.id } : {}), toCompanionId: to.id,
      request, status: 'queued', createdAt: now,
    }
    await this.save(delegation)
    const current = this.tasks.require(task.id)
    await this.tasks.update(task.id, { expectedRevision: current.revision, status: 'doing', assigneeCompanionId: to.id }, from ? { kind: 'companion', companionId: from.id } : { kind: 'user' })
    Object.assign(delegation, { status: 'running' as const, startedAt: Date.now() })
    await this.save(delegation)
    void this.executeDelegation(delegation, task, from, to, request, input.parentSessionId)
    return structuredClone(delegation)
  }

  async reviewTask(input: { taskId: string; to: string }): Promise<{ accepted: true }> {
    const task = this.tasks.require(input.taskId)
    if (task.status !== 'review') throw new Error('只有待验收任务可以交给伙伴核验')
    if (this.activeReviews.has(task.id)) throw new Error('这个任务正在核验中')
    const reviewer = this.resolveCompanion(input.to)
    if (task.reviewerCompanionId && task.reviewerCompanionId !== reviewer.id) throw new Error('请选择任务中指定的验收伙伴')
    if (!task.reviewerCompanionId) {
      await this.tasks.update(task.id, { expectedRevision: task.revision, reviewerCompanionId: reviewer.id }, { kind: 'user' })
    }
    this.activeReviews.add(task.id)
    void this.executeReview(task.id, reviewer)
    return { accepted: true }
  }

  private async executeDelegation(delegation: PartnerDelegation, task: ReturnType<TaskBoardService['require']>, from: Companion | undefined, to: Companion, request: string, parentSessionId?: string): Promise<void> {
    try {
      const prompt = [
          from ? `你收到伙伴「${from.name}」委派的看板任务。` : '你收到用户从伙伴任务看板直接委派的任务。',
          `任务：${task.title}`,
          task.description ? `任务说明：${task.description}` : '',
          `委派要求：${request}`,
          '请真正完成能够完成的工作，并在结果中清楚说明产出、证据、未完成项和需要验收的内容。不要访问其他伙伴的私有会话或记忆。',
        ].filter(Boolean).join('\n\n')
      const result = this.sessionExecutor
        ? await this.sessionExecutor.execute({ sourceId: delegation.id, companion: to, prompt, ...(parentSessionId ? { parentSessionId } : {}) })
        : await this.executor.execute({ kind: 'delegation', sourceId: delegation.id, companion: to, ...(parentSessionId ? { parentSessionId } : {}), prompt, destroyAfterRun: true })
      Object.assign(delegation, {
        status: 'completed' as const, completedAt: Date.now(), executionRunId: result.run.id,
        resultSummary: result.output.slice(0, 2400),
      })
      await this.save(delegation)
      await this.tasks.completeExecution(task.id, result.output, { kind: 'companion', companionId: to.id })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      Object.assign(delegation, { status: 'failed' as const, completedAt: Date.now(), error: reason })
      await this.save(delegation).catch(() => {})
      const current = this.tasks.require(task.id)
      if (current.status === 'doing') await this.tasks.failExecution(task.id, reason, { kind: 'companion', companionId: to.id }).catch(() => {})
    }
  }

  private async executeReview(taskId: string, reviewer: Companion): Promise<void> {
    try {
      const current = this.tasks.require(taskId)
      const prompt = [
          '你收到一个伙伴看板任务的独立验收请求。请根据任务要求和执行结果核验真实性、完整性与可复现性。',
          `任务：${current.title}`,
          current.description ? `任务说明：${current.description}` : '',
          current.resultSummary ? `执行结果：\n${current.resultSummary}` : '执行者没有提交可见结果，请明确指出。',
          '请输出：验收结论建议（通过或打回）、核验证据、缺失项，以及若打回应如何修正。你只提供核验意见，最终通过或打回由用户决定。',
        ].filter(Boolean).join('\n\n')
      const result = this.sessionExecutor
        ? await this.sessionExecutor.execute({ sourceId: `review:${taskId}`, companion: reviewer, prompt })
        : await this.executor.execute({ kind: 'review', sourceId: taskId, companion: reviewer, prompt, destroyAfterRun: true })
      await this.tasks.recordReview(taskId, result.output, { kind: 'companion', companionId: reviewer.id })
    } catch (error) {
      await this.tasks.comment(taskId, `验收执行失败：${error instanceof Error ? error.message : String(error)}`, { kind: 'companion', companionId: reviewer.id }).catch(() => {})
    } finally {
      this.activeReviews.delete(taskId)
    }
  }

  private requireCompanion(id: string): Companion {
    const companion = this.store.snapshot().companions.find(item => item.id === id)
    if (!companion) throw new Error('Companion does not exist')
    return companion
  }

  private async save(value: PartnerDelegation): Promise<void> {
    await this.store.update(state => {
      state.delegations = state.delegations.filter(item => item.id !== value.id)
      appendBounded(state.delegations, structuredClone(value), 500)
    })
  }
}
