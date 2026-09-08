import type { PartnerState } from '../domain.js'
import { advanceRequirementRevision } from '../requirements/revisions.js'

/** Atomic removal. Missing prerequisites pause dependents instead of auto-unlocking. */
export function removeTaskRecords(state: PartnerState, ids: ReadonlySet<string>): string[] {
  const affected = new Set(ids)
  const requirementIds = new Set(state.tasks.filter(t => ids.has(t.id)).map(t => t.requirementId))
  state.tasks = state.tasks.filter(t => !ids.has(t.id))
  for (const task of state.tasks) {
    if (!task.dependencyTaskIds.some(id => ids.has(id))) continue
    task.dependencyTaskIds = task.dependencyTaskIds.filter(id => !ids.has(id))
    if (task.status !== 'done') {
      task.status = 'blocked'; task.autoRun = false
      task.resultSummary = '前置任务已取消或删除，请确认需求范围及依赖后再提交执行。'
      affected.add(task.id)
    }
    task.revision++; task.updatedAt = Date.now(); requirementIds.add(task.requirementId)
  }
  state.taskActivities = state.taskActivities.filter(item => !ids.has(item.taskId))
  state.delegations = state.delegations.filter(item => !affected.has(item.taskId))
  for (const item of state.requirements ?? []) {
    if (!requirementIds.has(item.id) || item.status === 'done') continue
    advanceRequirementRevision(item, true); item.status = 'planning'
    delete item.nextAttemptAt; delete item.lastError
  }
  return [...affected]
}

export function touchTaskRequirement(state: PartnerState, requirementId?: string, control = false): void {
  const item = state.requirements?.find(r => r.id === requirementId)
  if (!item || item.status === 'done') return
  advanceRequirementRevision(item, control)
  if (item.status === 'review') item.status = 'active'
  delete item.nextAttemptAt; delete item.lastError
}
