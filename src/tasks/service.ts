import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { oneOf, optionalText, record, requiredText, stringList } from '../core/validation.js'
import type { PartnerStore } from '../store.js'
import { TASK_PRIORITIES, TASK_STATUSES, type BoardTask, type TaskActivity } from './domain.js'

const MAX_TASKS = 500
const MAX_ACTIVITIES = 2000

export class TaskBoardService {
  private notifier?: (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void>

  constructor(private readonly store: PartnerStore) {}

  setProgressNotifier(notifier: (task: BoardTask, previousStatus: BoardTask['status']) => Promise<void>): void {
    this.notifier = notifier
  }

  snapshot(): { tasks: BoardTask[]; activities: TaskActivity[] } {
    const state = this.store.snapshot()
    return { tasks: state.tasks, activities: state.taskActivities }
  }

  async create(value: unknown, actor: TaskActor): Promise<BoardTask> {
    const input = record(value, 'task')
    const now = Date.now()
    const assigneeCompanionId = optionalText(input.assigneeCompanionId, 'assigneeCompanionId', 120)
    const reviewerCompanionId = optionalText(input.reviewerCompanionId, 'reviewerCompanionId', 120)
    this.assertCompanion(assigneeCompanionId)
    this.assertCompanion(reviewerCompanionId)
    if (assigneeCompanionId && reviewerCompanionId === assigneeCompanionId) throw new Error('验收伙伴不能与任务负责人相同')
    const dependencyTaskIds = stringList(input.dependencyTaskIds, 'dependencyTaskIds', 20, 120)
    this.assertDependencies(undefined, dependencyTaskIds)
    const task: BoardTask = {
      id: `task-${randomUUID()}`, title: requiredText(input.title, 'title', 200), description: typeof input.description === 'string' ? input.description.trim().slice(0, 8000) : '',
      status: input.status === undefined ? 'backlog' : oneOf(input.status, TASK_STATUSES, 'status'),
      priority: input.priority === undefined ? 'normal' : oneOf(input.priority, TASK_PRIORITIES, 'priority'),
      ...(assigneeCompanionId ? { assigneeCompanionId } : {}), createdBy: actor.kind,
      ...(reviewerCompanionId ? { reviewerCompanionId } : {}),
      ...(actor.companionId ? { creatorCompanionId: actor.companionId } : {}),
      ...(typeof input.creatorSessionId === 'string' && input.creatorSessionId.trim() ? { creatorSessionId: input.creatorSessionId.trim().slice(0, 180) } : {}),
      skillIds: stringList(input.skillIds, 'skillIds', 20, 120), dependencyTaskIds,
      ...(validTimestamp(input.dueAt) ? { dueAt: input.dueAt } : {}), revision: 1, createdAt: now, updatedAt: now,
    }
    if (started(task.status)) this.assertDependenciesComplete(task, this.store.snapshot().tasks)
    await this.store.update(state => {
      if (state.tasks.length >= MAX_TASKS) throw new Error(`Task board reached its ${MAX_TASKS} task limit; archive or delete completed tasks first`)
      state.tasks.push(task)
      appendActivity(state.taskActivities, task.id, actor, 'created', `创建任务：${task.title}`, now)
    })
    return task
  }

  async update(taskId: string, value: unknown, actor: TaskActor): Promise<BoardTask> {
    const input = record(value, 'task')
    let output!: BoardTask
    let previousStatus!: BoardTask['status']
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('Task does not exist')
      const expected = input.expectedRevision
      if (!Number.isInteger(expected) || expected !== task.revision) throw new TaskConflictError(task)
      previousStatus = task.status
      if (input.title !== undefined) task.title = requiredText(input.title, 'title', 200)
      if (input.description !== undefined) task.description = typeof input.description === 'string' ? input.description.trim().slice(0, 8000) : task.description
      if (input.status !== undefined) task.status = oneOf(input.status, TASK_STATUSES, 'status')
      if (input.priority !== undefined) task.priority = oneOf(input.priority, TASK_PRIORITIES, 'priority')
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
      if (task.assigneeCompanionId && task.reviewerCompanionId === task.assigneeCompanionId) throw new Error('验收伙伴不能与任务负责人相同')
      if (input.skillIds !== undefined) task.skillIds = stringList(input.skillIds, 'skillIds', 20, 120)
      if (input.dependencyTaskIds !== undefined) {
        const dependencies = stringList(input.dependencyTaskIds, 'dependencyTaskIds', 20, 120)
        this.assertDependencies(task.id, dependencies, state.tasks)
        task.dependencyTaskIds = dependencies
      }
      if ('dueAt' in input) { if (validTimestamp(input.dueAt)) task.dueAt = input.dueAt; else delete task.dueAt }
      if (task.status === 'done' && previousStatus !== 'done' && previousStatus !== 'review') throw new Error('任务必须先进入待验收，才能标记为已完成')
      if (started(task.status)) this.assertDependenciesComplete(task, state.tasks)
      task.revision += 1
      task.updatedAt = Date.now()
      if (task.status === 'done' && previousStatus !== 'done') task.completedAt = task.updatedAt
      if (task.status !== 'done') delete task.completedAt
      if (task.status === 'doing' && previousStatus !== 'doing') { delete task.resultSummary; delete task.reviewSummary }
      const kind: TaskActivity['kind'] = task.status !== previousStatus ? (task.status === 'done' ? 'completed' : previousStatus === 'done' ? 'reopened' : 'moved') : 'updated'
      appendActivity(state.taskActivities, task.id, actor, kind, task.status !== previousStatus ? `${previousStatus} → ${task.status}` : '更新任务', task.updatedAt)
      output = structuredClone(task)
    })
    await this.notifyProgress(output, previousStatus)
    return output
  }

  async comment(taskId: string, message: string, actor: TaskActor): Promise<void> {
    await this.store.update(state => {
      if (!state.tasks.some(item => item.id === taskId)) throw new Error('Task does not exist')
      appendActivity(state.taskActivities, taskId, actor, 'commented', requiredText(message, 'message', 1200), Date.now())
    })
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
    if (!task) throw new Error('Task does not exist')
    if (task.status === 'doing') throw new Error('任务已经在执行中')
    if (task.status === 'review') throw new Error('任务正在等待验收，不能重复执行')
    if (task.status === 'done') throw new Error('任务已经完成，如需重做请先打回')
    this.assertDependenciesComplete(task, state.tasks)
    return task
  }

  async completeExecution(taskId: string, result: string, actor: TaskActor): Promise<BoardTask> {
    let output!: BoardTask
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('Task does not exist')
      if (task.status !== 'doing' && task.status !== 'review') throw new Error('只有进行中或待验收的任务可以提交执行结果')
      task.resultSummary = boundedText(result, 'result', 12_000)
      delete task.reviewSummary
      const movedToReview = task.status === 'doing'
      if (movedToReview) task.status = 'review'
      task.revision += 1
      task.updatedAt = Date.now()
      appendActivity(state.taskActivities, task.id, actor, 'result', movedToReview ? '执行结果已提交，等待验收' : '执行结果已补充到待验收任务', task.updatedAt)
      output = structuredClone(task)
    })
    return output
  }

  async recordReview(taskId: string, result: string, actor: TaskActor): Promise<BoardTask> {
    let output!: BoardTask
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('Task does not exist')
      if (task.status !== 'review') throw new Error('只有待验收任务可以提交核验结果')
      if (task.reviewerCompanionId && actor.companionId !== task.reviewerCompanionId) throw new Error('核验结果必须由任务指定的验收伙伴提交')
      task.reviewSummary = boundedText(result, 'reviewResult', 12_000)
      task.revision += 1
      task.updatedAt = Date.now()
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
      if (!task) throw new Error('Task does not exist')
      previousStatus = task.status
      task.resultSummary = `执行受阻：${boundedText(error, 'error', 4000)}`
      task.status = 'blocked'
      task.revision += 1
      task.updatedAt = Date.now()
      appendActivity(state.taskActivities, task.id, actor, 'failed', task.resultSummary, task.updatedAt)
      output = structuredClone(task)
    })
    await this.notifyProgress(output, previousStatus)
    return output
  }

  async accept(taskId: string, actor: TaskActor): Promise<BoardTask> {
    const current = this.require(taskId)
    if (current.status !== 'review') throw new Error('只有待验收任务可以通过验收')
    return this.update(taskId, { expectedRevision: current.revision, status: 'done' }, actor)
  }

  async reject(taskId: string, reason: string, actor: TaskActor): Promise<BoardTask> {
    let output!: BoardTask
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('Task does not exist')
      if (task.status !== 'review') throw new Error('只有待验收任务可以打回')
      const message = boundedText(reason, 'reason', 1200)
      task.status = 'ready'
      delete task.reviewSummary
      delete task.completedAt
      task.revision += 1
      task.updatedAt = Date.now()
      appendActivity(state.taskActivities, task.id, actor, 'reopened', `验收打回：${message}`, task.updatedAt)
      output = structuredClone(task)
    })
    return output
  }

  async remove(taskId: string): Promise<void> {
    await this.store.update(state => {
      state.tasks = state.tasks.filter(item => item.id !== taskId)
      for (const task of state.tasks) {
        if (!task.dependencyTaskIds.includes(taskId)) continue
        task.dependencyTaskIds = task.dependencyTaskIds.filter(id => id !== taskId)
        task.revision += 1
        task.updatedAt = Date.now()
      }
      state.taskActivities = state.taskActivities.filter(item => item.taskId !== taskId)
      state.delegations = state.delegations.filter(item => item.taskId !== taskId)
    })
  }

  require(taskId: string): BoardTask {
    const task = this.store.snapshot().tasks.find(item => item.id === taskId)
    if (!task) throw new Error('Task does not exist')
    return task
  }

  private assertCompanion(id: string | undefined): void {
    if (id && !this.store.snapshot().companions.some(item => item.id === id)) throw new Error('Assigned companion does not exist')
  }

  private assertDependencies(taskId: string | undefined, ids: string[], tasks = this.store.snapshot().tasks): void {
    const byId = new Map(tasks.map(task => [task.id, task]))
    for (const id of ids) {
      if (id === taskId) throw new Error('任务不能依赖自己')
      if (!byId.has(id)) throw new Error(`前置任务不存在：${id}`)
    }
    if (!taskId) return
    const reaches = (currentId: string, visited: Set<string>): boolean => {
      if (currentId === taskId) return true
      if (visited.has(currentId)) return false
      visited.add(currentId)
      return (byId.get(currentId)?.dependencyTaskIds ?? []).some(id => reaches(id, visited))
    }
    if (ids.some(id => reaches(id, new Set()))) throw new Error('任务依赖不能形成循环')
  }

  private assertDependenciesComplete(task: BoardTask, tasks: BoardTask[]): void {
    const byId = new Map(tasks.map(item => [item.id, item]))
    const pending = task.dependencyTaskIds.map(id => byId.get(id)).filter(item => item?.status !== 'done')
    if (pending.length > 0) throw new Error(`前置任务尚未完成：${pending.map(item => item?.title ?? '已删除任务').join('、')}`)
  }

  private async notifyProgress(task: BoardTask, previousStatus: BoardTask['status']): Promise<void> {
    if (task.status === previousStatus || (task.status !== 'done' && task.status !== 'blocked') || !task.creatorCompanionId) return
    await this.notifier?.(task, previousStatus)
  }
}

export interface TaskActor { kind: 'user' | 'companion' | 'schedule'; companionId?: string }

export class TaskConflictError extends Error {
  readonly status = 409
  constructor(readonly current: BoardTask) { super('Task changed; refresh it before updating') }
}

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
