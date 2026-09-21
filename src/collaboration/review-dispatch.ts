import type { PartnerState } from '../domain.js'
import { delegationKind, delegationPending, type PartnerDelegation } from './domain.js'
import { taskDelegation, taskDispatchDenied } from './task-dispatch.js'

/** Reconcile committed results, never restart an executor or revive failed attempts. */
export function automaticReviewCandidates(state: PartnerState): PartnerDelegation[] {
  return state.tasks.flatMap(task => {
    if (!task.autoRun || task.status !== 'review' || task.replanRequested || !task.reviewerCompanionId || !task.resultSummary?.trim() || task.reviewSummary?.trim()) return []
    const related = state.delegations.filter(d => d.taskId === task.id)
    if (related.some(delegationPending)) return []
    const previous = related.filter(d => delegationKind(d) === 'review' && d.toCompanionId === task.reviewerCompanionId).at(-1)
    if (previous && (previous.reviewWorkRevision ?? 1) === (task.workRevision ?? 1)) return []
    const item = taskDelegation(task, { initiatedBy: task.creatorCompanionId ? 'companion' : 'user',
      ...(task.creatorCompanionId ? { fromCompanionId: task.creatorCompanionId } : {}),
      to: task.reviewerCompanionId, request: '验收已保存的交付结果' })
    item.kind = 'review'; item.automaticReview = true; item.reviewWorkRevision = task.workRevision ?? 1
    return taskDispatchDenied(state, item) ? [] : [item]
  })
}
