import type { PartnerState } from '../domain.js'
import type { BoardTask } from '../tasks/domain.js'
import { delegationKind, type PartnerDelegation } from './domain.js'
import { taskDispatchDenied } from './task-dispatch.js'

/** A worker's early status update is not a committed result. */
export function unfinishedReview(task: BoardTask, item: PartnerDelegation): boolean {
  return delegationKind(item) === 'task' && task.status === 'review'
    && !task.resultSummary?.trim() && !task.reviewSummary?.trim()
    && (item.attempts ?? 0) > 0
    && (!task.assigneeCompanionId || task.assigneeCompanionId === item.toCompanionId)
}

/** Repair only identifiable coordinator mistakes, never arbitrary cancellations. */
export function repairableReviewCancellation(state: PartnerState, task: BoardTask, item: PartnerDelegation): boolean {
  if (item.status !== 'canceled' || !unfinishedReview(task, item) || taskDispatchDenied(state, item)) return false
  // A newer delegation supersedes this execution, even if it too has finished.
  const latest = state.delegations.filter(value => value.taskId === task.id && delegationKind(value) === 'task').at(-1)
  if (latest?.id !== item.id) return false
  if (item.error === '任务状态已经变为 review，忽略旧执行结果') return true
  const completedAt = item.completedAt
  if (item.error !== '任务或负责人已改变，取消旧执行' || !completedAt || task.updatedAt > completedAt) return false
  const attemptAt = item.lastAttemptAt ?? item.startedAt
  if (!attemptAt) return false
  return state.taskActivities.some(activity => activity.taskId === task.id && activity.actor === 'system'
    && activity.kind === 'retrying' && activity.message === '服务正在停止，执行已安全放回恢复队列'
    && activity.at >= attemptAt && activity.at <= completedAt)
}
