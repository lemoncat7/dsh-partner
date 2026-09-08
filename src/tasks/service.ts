import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { oneOf, optionalBoolean, optionalText, record, requiredText, stringList } from '../core/validation.js'
import type { PartnerStore } from '../store.js'
import { TASK_PRIORITIES, TASK_STATUSES, type BoardTask, type TaskActivity } from './domain.js'
import type { TaskExecutionOutput } from './result.js'
import { requirementDraft } from '../requirements/draft.js'
import { removeTaskRecords, touchTaskRequirement } from './removal.js'
import { invalidateTaskWork, preserveTaskAttempt } from './context.js'
import { requireTaskRequirement } from './requirement-link.js'
import { TaskWorkflowError } from './workflow-error.js'
import { taskDraft, assertTaskDependencies } from './draft.js'
import { acceptanceCriteria, resourceKeys, taskEvidence, reviewChecks } from './contract.js'
import { taskScheduling, executionWait } from './scheduling.js'

const MAX_TASKS = 500
const MAX_ACTIVITIES = 2000

export class TaskBoardService {
  private notifier?: (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void>
  private removalNotifier?: (ids: string[]) => void
  private liveClaims: () => readonly import('../collaboration/domain.js').PartnerDelegation[] = () => []
  setLiveClaims(provider: typeof this.liveClaims): void { this.liveClaims = provider }

  constructor(private readonly store: PartnerStore) {}
  setRemovalNotifier(notifier: (ids: string[]) => void): void { this.removalNotifier = notifier }

  setProgressNotifier(notifier: (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void>): void {
    this.notifier = notifier
  }

  snapshot() {
    const state = this.store.snapshot()
    const active = this.liveClaims()
    return { tasks: state.tasks.map(task => ({ ...task, scheduling: taskScheduling(state, task, active) })), activities: state.taskActivities, requirements: state.requirements ?? [] }
  }

  async create(value: unknown, actor: TaskActor, requireOwnership = false): Promise<BoardTask> {
    const input = record(value, 'task')
    let task!: BoardTask
    await this.store.update(state => {
      task = taskDraft(input, actor, state)
      const dependencyTaskIds = task.dependencyTaskIds
      if (requireOwnership) requireTaskRequirement(input.requirementId, dependencyTaskIds, state.tasks)
      if (started(task.status)) this.assertDependenciesComplete(task, state.tasks)
      if (task.status === 'done' && task.acceptanceCriteria?.length) throw new Error('有验收清单的任务必须先执行并逐项验收，不能直接创建为已完成')
      if (task.status === 'doing' && executionWait(state, task, this.liveClaims())?.code === 'resource_busy') throw new Error('共享资源正被其他任务使用，请等待释放后启动')
      if (state.tasks.length >= MAX_TASKS) throw new Error(`Task board reached its ${MAX_TASKS} task limit; archive or delete completed tasks first`)
      this.assertDependencies(undefined, dependencyTaskIds, state.tasks)
      state.requirements ??= []
      const requirementId = optionalText(input.requirementId, 'requirementId', 160)
      if (requirementId) {
        const requirement = state.requirements.find(r => r.id === requirementId)
        if (!requirement) throw new TaskNotFoundError('需求已删除或不存在')
        if (requirement.status !== 'planning') throw new TaskWorkflowError('REQUIREMENT_NOT_PLANNING', '请先将需求重新打开为规划状态，再增加任务',
          { requirementId, status: requirement.status, ownerCompanionId: requirement.ownerCompanionId, revision: requirement.revision },
          '只有需求负责人可 reopen 后追加任务。若你是正在执行的子任务负责人且缺工具、需要拆分或换人，使用 partner_task_board request_replan（taskId、expectedRevision、message），随后结束本轮；不要重建需求或重复 create。')
        task.requirementId = requirementId
      } else {
        if (state.requirements.length >= 500) throw new Error('需求数量已达上限')
        const requirement = requirementDraft(task.title, task.description, task.creatorCompanionId, task.creatorSessionId)
        requirement.status = 'active'
        state.requirements.push(requirement); task.requirementId = requirement.id
      }
      touchTaskRequirement(state, task.requirementId)
      state.tasks.push(task)
      appendActivity(state.taskActivities, task.id, actor, 'created', `创建任务：${task.title}`, task.createdAt)
    })
    return task
  }

  async update(taskId: string, value: unknown, actor: TaskActor): Promise<BoardTask> {
    const input = record(value, 'task')
    let output!: BoardTask
    let previousStatus!: BoardTask['status']
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new TaskNotFoundError()
      if (state.requirements?.some(r => r.id === task.requirementId && r.status === 'done')) throw new Error('已归档需求中的任务不能修改；同一目标续做请 reopen 原需求后追加新任务，不要重跑已验收任务')
      const expected = input.expectedRevision
      if (!Number.isInteger(expected) || expected !== task.revision) throw new TaskConflictError(task)
      previousStatus = task.status
      const originalReviewer = task.reviewerCompanionId ?? task.creatorCompanionId
      if (task.replanRequested) {
        const owner = state.requirements?.find(r => r.id === task.requirementId)?.ownerCompanionId ?? task.creatorCompanionId
        if (actor.kind !== 'user' && actor.companionId !== owner) throw new Error('任务已暂停等待重规划，仅需求负责人或用户可以调整和恢复；不要重复执行')
      }
      const previousSpec = JSON.stringify([task.title, task.description, task.assigneeCompanionId, task.skillIds, task.dependencyTaskIds, task.acceptanceCriteria, task.resourceKeys])
      if (input.title !== undefined) task.title = requiredText(input.title, 'title', 200)
      if (input.description !== undefined) task.description = typeof input.description === 'string' ? input.description.trim().slice(0, 8000) : task.description
      if (input.status !== undefined) task.status = oneOf(input.status, TASK_STATUSES, 'status')
      if (input.priority !== undefined) task.priority = oneOf(input.priority, TASK_PRIORITIES, 'priority')
      if (input.autoRun !== undefined) {
        task.autoRun = optionalBoolean(input.autoRun, false)
        if (!task.autoRun) for (const item of state.delegations) {
          if (item.taskId !== task.id || item.status !== 'queued' || item.kind === 'review') continue
          item.status = 'canceled'; item.completedAt = Date.now(); item.error = '任务已改为仅规划，取消尚未开始的执行'
          delete item.nextAttemptAt
        }
      }
      if ('assigneeCompanionId' in input) {
        const assignee = optionalText(input.assigneeCompanionId, 'assigneeCompanionId', 120)
        this.assertCompanion(assignee)
        if (assignee) task.assigneeCompanionId = assignee
        else delete task.assigneeCompanionId
      }
      if ('reviewerCompanionId' in input) {
        const reviewer = optionalText(input.reviewerCompanionId, 'reviewerCompanionId', 120)
        this.assertCompanion(reviewer)
        if (reviewer) task.reviewerCompanionId = reviewer
        else delete task.reviewerCompanionId
      }
      if (!task.reviewerCompanionId && task.creatorCompanionId && (task.status === 'review' || task.status === 'done')) {
        task.reviewerCompanionId = task.creatorCompanionId
      }
      if (input.skillIds !== undefined) task.skillIds = stringList(input.skillIds, 'skillIds', 20, 120)
      if (input.acceptanceCriteria !== undefined) task.acceptanceCriteria = acceptanceCriteria(input.acceptanceCriteria)
      if (input.resourceKeys !== undefined) task.resourceKeys = resourceKeys(input.resourceKeys)
      if (input.dependencyTaskIds !== undefined) {
        const dependencies = stringList(input.dependencyTaskIds, 'dependencyTaskIds', 20, 120)
        this.assertDependencies(task.id, dependencies, state.tasks)
        task.dependencyTaskIds = dependencies
      }
      if ('dueAt' in input) { if (validTimestamp(input.dueAt)) task.dueAt = input.dueAt; else delete task.dueAt }
      const specChanged = previousSpec !== JSON.stringify([task.title, task.description, task.assigneeCompanionId, task.skillIds, task.dependencyTaskIds, task.acceptanceCriteria, task.resourceKeys])
      if (specChanged) {
        invalidateTaskWork(state, task, '任务要求或分配已更新，旧执行/验收失效')
        task.reworkCount = 0
      }
      if (task.replanRequested && input.autoRun === true) {
        task.replanRequested = false; task.reworkCount = 0
        if (task.status === 'blocked') task.status = 'ready'
      }
      if (input.autoRun === true && !task.assigneeCompanionId) throw new Error('提交执行需要指定负责人')
      if (task.status === 'done' && previousStatus !== 'done' && previousStatus !== 'review') throw new Error('任务必须先进入待验收，才能标记为已完成')
      if (task.status === 'done' && previousStatus !== 'done') {
        if (actor.kind !== 'user' && originalReviewer && originalReviewer !== actor.companionId) throw new Error('当前伙伴不是这个任务的验收者')
        task.reviewChecks = reviewChecks(input.checks, task.acceptanceCriteria ?? [], true)
      }
      if (started(task.status)) this.assertDependenciesComplete(task, state.tasks)
      if (task.status === 'doing' && previousStatus !== 'doing' && executionWait(state, task, this.liveClaims())?.code === 'resource_busy') throw new Error('共享资源正被其他任务使用，请等待释放后启动')
      task.revision += 1
      task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId, specChanged)
      if (task.status === 'done' && previousStatus !== 'done') task.completedAt = task.updatedAt
      if (task.status !== 'done') delete task.completedAt
      if (task.status === 'doing' && previousStatus !== 'doing') {
        preserveTaskAttempt(task)
        delete task.resultAbstract
        delete task.resultSummary
        delete task.reviewHandoff
        delete task.reviewSummary
        delete task.evidence
        delete task.reviewChecks
      }
      const kind: TaskActivity['kind'] = task.status !== previousStatus ? (task.status === 'done' ? 'completed' : previousStatus === 'done' ? 'reopened' : 'moved') : 'updated'
      appendActivity(state.taskActivities, task.id, actor, kind, task.status !== previousStatus ? `${previousStatus} → ${task.status}` : '更新任务', task.updatedAt)
      output = structuredClone(task)
    })
    await this.notifyProgress(output, previousStatus)
    return output
  }

  async comment(taskId: string, message: string, actor: TaskActor): Promise<void> {
    let task!: BoardTask
    await this.store.update(state => {
      const current = state.tasks.find(item => item.id === taskId)
      if (!current) throw new TaskNotFoundError()
      appendActivity(state.taskActivities, taskId, actor, 'commented', requiredText(message, 'message', 1200), Date.now())
      current.revision++; current.updatedAt = Date.now()
      touchTaskRequirement(state, current.requirementId)
      task = structuredClone(current)
    })
    if (task.status === 'review') await this.notifyProgress(task, 'review', true)
  }

  async recordRecovery(taskId: string, message: string, retrying: boolean): Promise<void> {
    await this.store.update(state => {
      if (!state.tasks.some(item => item.id === taskId)) return
      appendActivity(state.taskActivities, taskId, { kind: 'system' }, retrying ? 'retrying' : 'recovered', requiredText(message, 'message', 1200), Date.now())
    })
  }

  assertStartable(taskId: string): BoardTask {
    const state = this.store.snapshot()
    const task = state.tasks.find(item => item.id === taskId)
    if (!task) throw new TaskNotFoundError()
    if (task.status === 'doing') throw new Error('任务已经在执行中')
    if (task.status === 'review') throw new Error('任务正在等待验收，不能重复执行')
    if (task.status === 'done') throw new Error('任务已经完成，如需重做请先打回')
    this.assertDependenciesComplete(task, state.tasks)
    return task
  }

  async completeExecution(taskId: string, result: string | TaskExecutionOutput, actor: TaskActor, workRevision?: number): Promise<BoardTask> {
    let output!: BoardTask
    let previousStatus!: BoardTask['status']
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new TaskNotFoundError()
      if (task.status !== 'doing' && task.status !== 'review') throw new Error('只有进行中或待验收的任务可以提交执行结果')
      if (workRevision !== undefined && workRevision !== (task.workRevision ?? 1)) throw new TaskConflictError(task)
      previousStatus = task.status
      if (!task.reviewerCompanionId && task.creatorCompanionId) task.reviewerCompanionId = task.creatorCompanionId
      const execution = typeof result === 'string' ? { deliverable: result } : result
      let evidenceWarning = execution.evidenceWarning
      try { task.evidence = taskEvidence(execution.evidence, task.acceptanceCriteria ?? []) }
      catch { task.evidence = []; evidenceWarning = '证据结构或编号无效：交付已保留，验收者需实际核验或打回补证，不要重跑已完成的外部操作。' }
      delete task.reviewChecks
      task.resultSummary = boundedText(execution.deliverable, 'result', 12_000)
      if (execution.summary?.trim()) task.resultAbstract = execution.summary.trim().slice(0, 600)
      else delete task.resultAbstract
      const handoff = [evidenceWarning, execution.reviewHandoff?.trim()].filter(Boolean).join('\n\n')
      if (handoff) task.reviewHandoff = handoff.slice(0, 4_000)
      else delete task.reviewHandoff
      delete task.reviewSummary
      const movedToReview = task.status === 'doing'
      if (movedToReview) task.status = 'review'
      task.revision += 1
      task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId)
      appendActivity(state.taskActivities, task.id, actor, 'result', movedToReview ? '执行结果已提交，等待验收' : '执行结果已补充到待验收任务', task.updatedAt)
      output = structuredClone(task)
    })
    await this.notifyProgress(output, previousStatus, true)
    return output
  }

  async recordReview(taskId: string, result: string, actor: TaskActor, expectedRevision?: number): Promise<BoardTask> {
    let output!: BoardTask
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new TaskNotFoundError()
      if (task.status !== 'review') throw new Error('只有待验收任务可以提交核验结果')
      if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new TaskConflictError(task)
      if (task.reviewerCompanionId && actor.companionId !== task.reviewerCompanionId) throw new Error('核验结果必须由任务指定的验收伙伴提交')
      task.reviewSummary = boundedText(result, 'reviewResult', 12_000)
      task.revision += 1
      task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId)
      appendActivity(state.taskActivities, task.id, actor, 'reviewed', '验收伙伴已提交核验结果', task.updatedAt)
      output = structuredClone(task)
    })
    return output
  }

  async failExecution(taskId: string, error: string, actor: TaskActor): Promise<BoardTask> {
    let output!: BoardTask
    let previousStatus!: BoardTask['status']
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new TaskNotFoundError()
      previousStatus = task.status
      if (task.status !== 'doing') throw new Error('只有进行中的任务可以报告执行失败')
      task.resultSummary = `执行受阻：${boundedText(error, 'error', 4000)}`
      delete task.resultAbstract
      delete task.reviewHandoff
      task.status = 'blocked'
      task.revision += 1
      task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId)
      appendActivity(state.taskActivities, task.id, actor, 'failed', task.resultSummary, task.updatedAt)
      output = structuredClone(task)
    })
    await this.notifyProgress(output, previousStatus)
    return output
  }

  async accept(taskId: string, actor: TaskActor, expectedRevision?: number, checks?: unknown): Promise<BoardTask> {
    const current = this.require(taskId)
    if (current.status !== 'review') throw new Error('只有待验收任务可以通过验收')
    return this.update(taskId, { expectedRevision: expectedRevision ?? current.revision, status: 'done', checks }, actor)
  }

  async reject(taskId: string, reason: string, actor: TaskActor, expectedRevision?: number, mode: 'rework' | 'replan' = 'rework', checks?: unknown): Promise<BoardTask> {
    let output!: BoardTask
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new TaskNotFoundError()
      if (task.status !== 'review') throw new Error('只有待验收任务可以打回')
      if (expectedRevision !== undefined && expectedRevision !== task.revision) throw new TaskConflictError(task)
      const message = boundedText(reason, 'reason', 1200)
      if (actor.kind !== 'user' && task.reviewerCompanionId && task.reviewerCompanionId !== actor.companionId) throw new Error('当前伙伴不是这个任务的验收者')
      task.reviewChecks = reviewChecks(checks, task.acceptanceCriteria ?? [], false)
      task.rejectionReason = message; task.rejectedAt = Date.now()
      task.reworkCount = (task.reworkCount ?? 0) + 1
      invalidateTaskWork(state, task, '验收打回，旧执行/验收已失效')
      task.status = 'ready'
      if (mode === 'replan' || task.reworkCount >= 3) {
        task.status = 'blocked'; task.autoRun = false; task.replanRequested = true
        task.resultSummary = `需要需求负责人重新规划：${message}`
      }
      delete task.reviewSummary
      delete task.completedAt
      task.revision += 1
      task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId)
      appendActivity(state.taskActivities, task.id, actor, 'reopened', `验收打回：${message}`, task.updatedAt)
      output = structuredClone(task)
    })
    if (output.replanRequested) await this.notifyProgress(output, 'review')
    return output
  }

  /** Atomically relinquish a task before asking its owner to split or reassign it. */
  async requestReplan(taskId: string, reason: string, actor: TaskActor, revision: number): Promise<BoardTask> {
    let output!: BoardTask, previous!: BoardTask['status'], changed = false
    await this.store.update(state => {
      const task = state.tasks.find(t => t.id === taskId)
      if (!task) throw new TaskNotFoundError()
      const owner = state.requirements?.find(r => r.id === task.requirementId)?.ownerCompanionId ?? task.creatorCompanionId
      if (actor.kind !== 'user' && actor.companionId !== task.assigneeCompanionId && actor.companionId !== owner)
        throw new Error('只有当前执行者、需求负责人或用户可以申请重规划')
      if (task.replanRequested) { output = structuredClone(task); return }
      if (revision !== task.revision) throw new TaskConflictError(task)
      if (!['ready', 'doing', 'blocked'].includes(task.status)) throw new Error('仅待开始、执行中或受阻任务可申请重规划；待验收请由验收者 reject，已完成不重跑')
      const message = boundedText(reason, 'message', 1200)
      previous = task.status
      invalidateTaskWork(state, task, `重规划暂停：${message}`)
      task.status = 'blocked'; task.autoRun = false; task.replanRequested = true
      task.resultSummary = `需要需求负责人重新规划：${message}`
      task.revision++; task.updatedAt = Date.now()
      touchTaskRequirement(state, task.requirementId)
      appendActivity(state.taskActivities, task.id, actor, 'failed', task.resultSummary, task.updatedAt)
      output = structuredClone(task); changed = true
    })
    if (changed) await this.notifyProgress(output, previous)
    return output
  }

  async remove(taskId: string): Promise<void> {
    let affected: string[] = []
    await this.store.update(state => {
      affected = removeTaskRecords(state, new Set([taskId]))
    })
    this.removalNotifier?.(affected)
  }

  async removeRequirement(id: string): Promise<void> {
    let affected: string[] = []
    await this.store.update(state => {
      affected = removeTaskRecords(state, new Set(state.tasks.filter(t => t.requirementId === id).map(t => t.id)))
      state.requirements = (state.requirements ?? []).filter(r => r.id !== id)
    })
    this.removalNotifier?.(affected)
  }

  require(taskId: string): BoardTask {
    const task = this.store.snapshot().tasks.find(item => item.id === taskId)
    if (!task) throw new TaskNotFoundError()
    return task
  }

  private assertCompanion(id: string | undefined): void {
    if (id && !this.store.snapshot().companions.some(item => item.id === id)) throw new Error('Assigned companion does not exist')
  }

  private assertDependencies(taskId: string | undefined, ids: string[], tasks = this.store.snapshot().tasks): void {
    assertTaskDependencies(taskId, ids, tasks)
  }

  private assertDependenciesComplete(task: BoardTask, tasks: BoardTask[]): void {
    const byId = new Map(tasks.map(item => [item.id, item]))
    const pending = task.dependencyTaskIds.map(id => byId.get(id)).filter(item => item?.status !== 'done')
    if (pending.length > 0) throw new Error(`前置任务尚未完成：${pending.map(item => item?.title ?? '已删除任务').join('、')}`)
  }

  private async notifyProgress(task: BoardTask, previousStatus: BoardTask['status'], resultSubmitted = false): Promise<void> {
    if (task.replanRequested && task.status === 'blocked') {
      const owner = this.store.snapshot().requirements?.find(r => r.id === task.requirementId)?.ownerCompanionId
      if (owner || task.creatorCompanionId) await this.notifier?.(task, previousStatus)
      return
    }
    if (!task.creatorCompanionId) return
    if (task.status === 'review') {
      if (!task.resultSummary || (!resultSubmitted && task.status === previousStatus)) return
    } else if (task.status === previousStatus || (task.status !== 'done' && task.status !== 'blocked')) return
    await this.notifier?.(task, previousStatus)
  }
}

export interface TaskActor { kind: 'user' | 'companion' | 'schedule'; companionId?: string }

export class TaskConflictError extends Error {
  readonly status = 409
  constructor(readonly current: BoardTask) {
    super(`任务状态已更新（Task changed；${current.id}，当前版本 ${current.revision}，状态 ${current.status}）。请通过 partner_task_board list 核对最新任务、评论和交付后再操作；验收不得仅替换 expectedRevision 重交旧意见，也不要重复创建任务。`)
  }
}
export class TaskNotFoundError extends Error { readonly status = 404; constructor(message = '任务已删除或不存在，无需继续处理') { super(message) } }

function appendActivity(items: TaskActivity[], taskId: string, actor: TaskActor | { kind: 'system' }, kind: TaskActivity['kind'], message: string, at: number): void {
  appendBounded(items, {
    id: `activity-${randomUUID()}`, taskId, actor: actor.kind, ...('companionId' in actor && actor.companionId ? { actorCompanionId: actor.companionId } : {}), kind, message, at,
  }, MAX_ACTIVITIES)
}
function validTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
function started(status: BoardTask['status']): boolean { return status === 'doing' || status === 'review' || status === 'done' }
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim().slice(0, max)
}
