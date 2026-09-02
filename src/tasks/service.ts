import { randomUUID } from 'node:crypto'
import { appendBounded } from '../core/collections.js'
import { oneOf, optionalText, record, requiredText, stringList } from '../core/validation.js'
import type { PartnerStore } from '../store.js'
import { TASK_PRIORITIES, TASK_STATUSES, type BoardTask, type TaskActivity } from './domain.js'

const MAX_TASKS = 500
const MAX_ACTIVITIES = 2000

export class TaskBoardService {
  constructor(private readonly store: PartnerStore) {}

  snapshot(): { tasks: BoardTask[]; activities: TaskActivity[] } {
    const state = this.store.snapshot()
    return { tasks: state.tasks, activities: state.taskActivities }
  }

  async create(value: unknown, actor: TaskActor): Promise<BoardTask> {
    const input = record(value, 'task')
    const now = Date.now()
    const assigneeCompanionId = optionalText(input.assigneeCompanionId, 'assigneeCompanionId', 120)
    this.assertCompanion(assigneeCompanionId)
    const task: BoardTask = {
      id: `task-${randomUUID()}`, title: requiredText(input.title, 'title', 200), description: typeof input.description === 'string' ? input.description.trim().slice(0, 8000) : '',
      status: input.status === undefined ? 'backlog' : oneOf(input.status, TASK_STATUSES, 'status'),
      priority: input.priority === undefined ? 'normal' : oneOf(input.priority, TASK_PRIORITIES, 'priority'),
      ...(assigneeCompanionId ? { assigneeCompanionId } : {}), createdBy: actor.kind,
      ...(actor.companionId ? { creatorCompanionId: actor.companionId } : {}),
      skillIds: stringList(input.skillIds, 'skillIds', 20, 120), relatedTaskIds: stringList(input.relatedTaskIds, 'relatedTaskIds', 20, 120),
      ...(validTimestamp(input.dueAt) ? { dueAt: input.dueAt } : {}), revision: 1, createdAt: now, updatedAt: now,
    }
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
    await this.store.update(state => {
      const task = state.tasks.find(item => item.id === taskId)
      if (!task) throw new Error('Task does not exist')
      const expected = input.expectedRevision
      if (!Number.isInteger(expected) || expected !== task.revision) throw new TaskConflictError(task)
      const previousStatus = task.status
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
      if (input.skillIds !== undefined) task.skillIds = stringList(input.skillIds, 'skillIds', 20, 120)
      if (input.relatedTaskIds !== undefined) task.relatedTaskIds = stringList(input.relatedTaskIds, 'relatedTaskIds', 20, 120)
      if ('dueAt' in input) { if (validTimestamp(input.dueAt)) task.dueAt = input.dueAt; else delete task.dueAt }
      task.revision += 1
      task.updatedAt = Date.now()
      if (task.status === 'done' && previousStatus !== 'done') task.completedAt = task.updatedAt
      if (task.status !== 'done') delete task.completedAt
      const kind: TaskActivity['kind'] = task.status !== previousStatus ? (task.status === 'done' ? 'completed' : 'moved') : 'updated'
      appendActivity(state.taskActivities, task.id, actor, kind, task.status !== previousStatus ? `${previousStatus} → ${task.status}` : '更新任务', task.updatedAt)
      output = structuredClone(task)
    })
    return output
  }

  async comment(taskId: string, message: string, actor: TaskActor): Promise<void> {
    await this.store.update(state => {
      if (!state.tasks.some(item => item.id === taskId)) throw new Error('Task does not exist')
      appendActivity(state.taskActivities, taskId, actor, 'commented', requiredText(message, 'message', 1200), Date.now())
    })
  }

  async remove(taskId: string): Promise<void> {
    await this.store.update(state => {
      state.tasks = state.tasks.filter(item => item.id !== taskId)
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
}

export interface TaskActor { kind: 'user' | 'companion' | 'schedule'; companionId?: string }

export class TaskConflictError extends Error {
  readonly status = 409
  constructor(readonly current: BoardTask) { super('Task changed; refresh it before updating') }
}

function appendActivity(items: TaskActivity[], taskId: string, actor: TaskActor, kind: TaskActivity['kind'], message: string, at: number): void {
  appendBounded(items, {
    id: `activity-${randomUUID()}`, taskId, actor: actor.kind, ...(actor.companionId ? { actorCompanionId: actor.companionId } : {}), kind, message, at,
  }, MAX_ACTIVITIES)
}
function validTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 }
