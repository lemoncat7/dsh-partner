import { randomUUID } from 'node:crypto'
import type { PartnerState } from '../domain.js'
import { oneOf, optionalBoolean, optionalText, record, requiredText, stringList } from '../core/validation.js'
import { TASK_PRIORITIES, TASK_STATUSES, type BoardTask } from './domain.js'
import type { TaskActor } from './service.js'
import { acceptanceCriteria, resourceKeys } from './contract.js'

/** Shared pure creation boundary for single tasks and atomic plans. */
export function taskDraft(value: unknown, actor: TaskActor, state: PartnerState): BoardTask {
  const input = record(value, 'task'), now = Date.now()
  const assignee = optionalText(input.assigneeCompanionId, 'assigneeCompanionId', 120)
  const reviewer = optionalText(input.reviewerCompanionId, 'reviewerCompanionId', 120) ?? actor.companionId
  for (const id of [assignee, reviewer]) if (id && !state.companions.some(c => c.id === id)) throw new Error('Assigned companion does not exist')
  const autoRun = optionalBoolean(input.autoRun, false)
  if (autoRun && !assignee) throw new Error('提交执行需要指定负责人')
  const status = input.status === undefined ? autoRun ? 'ready' : 'backlog' : oneOf(input.status, TASK_STATUSES, 'status')
  if (autoRun && status !== 'ready') throw new Error('新提交的任务必须从待开始创建；收集箱请使用 autoRun=false，不能跳过执行和验收')
  return {
    id: `task-${randomUUID()}`, title: requiredText(input.title, 'title', 200),
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 8000) : '',
    status, ...(autoRun ? { autoRun: true } : {}),
    priority: input.priority === undefined ? 'normal' : oneOf(input.priority, TASK_PRIORITIES, 'priority'),
    ...(assignee ? { assigneeCompanionId: assignee } : {}), ...(reviewer ? { reviewerCompanionId: reviewer } : {}),
    createdBy: actor.kind, ...(actor.companionId ? { creatorCompanionId: actor.companionId } : {}),
    ...(typeof input.creatorSessionId === 'string' && input.creatorSessionId.trim() ? { creatorSessionId: input.creatorSessionId.trim().slice(0, 180) } : {}),
    skillIds: stringList(input.skillIds, 'skillIds', 20, 120), dependencyTaskIds: stringList(input.dependencyTaskIds, 'dependencyTaskIds', 20, 120),
    acceptanceCriteria: acceptanceCriteria(input.acceptanceCriteria), resourceKeys: resourceKeys(input.resourceKeys),
    ...(typeof input.dueAt === 'number' && Number.isFinite(input.dueAt) && input.dueAt > 0 ? { dueAt: input.dueAt } : {}),
    revision: 1, createdAt: now, updatedAt: now,
  }
}

export function assertTaskDependencies(taskId: string | undefined, ids: string[], tasks: readonly BoardTask[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const id of ids) {
    if (id === taskId) throw new Error('任务不能依赖自己')
    if (!byId.has(id)) throw new Error(`前置任务不存在：${id}`)
  }
  if (!taskId) return
  const reaches = (id: string, visited: Set<string>): boolean => {
    if (id === taskId) return true
    if (visited.has(id)) return false
    visited.add(id)
    return (byId.get(id)?.dependencyTaskIds ?? []).some(next => reaches(next, visited))
  }
  if (ids.some(id => reaches(id, new Set()))) throw new Error('任务依赖不能形成循环')
}
