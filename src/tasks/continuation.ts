import type { PartnerState } from '../domain.js'
import type { ScheduledPartnerTask } from '../scheduler/domain.js'
import { taskDispatchDenied } from '../collaboration/task-dispatch.js'

/** Board ownership is explicit and revision-bound; never suspend a whole companion. */
export function bindBoardContinuation(state: PartnerState, entry: ScheduledPartnerTask, taskId?: string): void {
  const wake = entry.continuation!
  const candidates = state.delegations.filter(d => d.kind !== 'review' && d.status === 'running'
    && d.toCompanionId === entry.companionId && d.executionSessionId === wake.originSessionId
    && (!taskId || d.taskId === taskId))
  if (!candidates.length && !taskId) return
  if (candidates.length !== 1) throw new Error('无法唯一确定当前执行的看板任务，请填写当前任务的 boardTaskId')
  const delegation = candidates[0]!
  const task = state.tasks.find(t => t.id === delegation.taskId)
  if (!task || task.status !== 'doing' || task.replanRequested) throw new Error('看板任务已变更，不能预约旧任务')
  if (state.schedules.some(s => s.continuation?.board?.taskId === task.id && ['waiting', 'running'].includes(s.continuation.state))) throw new Error('此看板任务已有等待预约，请先核实原预约，不能重复创建')
  wake.board = { taskId: task.id, delegationId: delegation.id, workRevision: task.workRevision ?? 1 }
  delegation.continuationScheduleId = entry.id
  delegation.status = 'queued'
  delete delegation.nextAttemptAt
  delete delegation.error
}

export function boardContinuation(state: PartnerState, taskId: string): ScheduledPartnerTask | undefined {
  return state.schedules.find(s => s.continuation?.board?.taskId === taskId
    && ['waiting', 'running'].includes(s.continuation.state))
}

/** Runs inside the same store transaction as edits/cancellation/receipts. */
export function reconcileBoardContinuations(state: PartnerState): void {
  const now = Date.now()
  // Task deletion can remove the delegation too; scan timers as well as jobs.
  for (const entry of state.schedules) {
    const wake = entry.continuation, link = wake?.board
    if (!wake || !link || !['waiting', 'running'].includes(wake.state)) continue
    const task = state.tasks.find(t => t.id === link.taskId)
    const job = state.delegations.find(d => d.id === link.delegationId)
    if (task?.status === 'doing' && !task.replanRequested && (task.workRevision ?? 1) === link.workRevision
      && task.assigneeCompanionId === entry.companionId && job?.continuationScheduleId === entry.id
      && ['queued', 'running'].includes(job.status)) continue
    wake.state = 'cancelled'; wake.summary = '看板任务已删除、改派、修改或结束，旧预约失效'
    delete wake.runToken; entry.enabled = false; entry.updatedAt = now
  }
  for (const delegation of state.delegations) {
    if (!delegation.continuationScheduleId) continue
    const entry = state.schedules.find(s => s.id === delegation.continuationScheduleId)
    const wake = entry?.continuation, link = wake?.board
    // Once resumed, normal execution/result handling owns the delegation again.
    if (delegation.status !== 'queued' && !['waiting', 'running'].includes(wake?.state ?? '')) continue
    const task = state.tasks.find(t => t.id === delegation.taskId)
    const valid = task && !task.replanRequested && task.status === 'doing'
      && task.assigneeCompanionId === delegation.toCompanionId && link?.delegationId === delegation.id
      && link.workRevision === (task.workRevision ?? 1) && !['canceled', 'failed', 'completed'].includes(delegation.status)
    if (!valid) {
      if (entry && wake && ['waiting', 'running'].includes(wake.state)) {
        wake.state = 'cancelled'; wake.summary = '看板任务已删除、改派、修改或结束，旧预约失效'
        delete wake.runToken; entry.enabled = false; entry.updatedAt = now
      }
      if (entry && ['queued', 'running'].includes(delegation.status)) {
        delegation.status = 'canceled'; delegation.completedAt = now
        delegation.error = '看板任务已变更，旧续接执行失效'
      }
      // A missing timer must block its work, not silently rerun external submission.
      if (entry || !task || delegation.status !== 'queued') continue
    }
    if (!task || !['queued', 'running'].includes(delegation.status)) continue
    if (!entry || taskDispatchDenied(state, delegation) || !state.companions.find(c => c.id === entry.companionId)?.capabilities.includes('schedules')
      || wake?.state === 'blocked' || wake?.state === 'cancelled') {
      task.status = 'blocked'; task.resultSummary = taskDispatchDenied(state, delegation) || wake?.summary || '长任务续接已取消、删除或权限撤回，请核实外部任务后再恢复'
      task.updatedAt = now; task.revision++
      delegation.status = 'failed'; delegation.error = task.resultSummary; delegation.completedAt = now
      if (entry && wake && ['waiting', 'running'].includes(wake.state)) {
        wake.state = 'blocked'; wake.summary = task.resultSummary; delete wake.runToken; entry.enabled = false
      }
    }
  }
}

export function continuationDispatchWait(state: PartnerState, taskId: string): { code: string; message: string; retryAt?: number } | undefined {
  const entry = boardContinuation(state, taskId)
  if (!entry) return
  return { code: 'external_wait', message: !entry.enabled ? '外部任务续接已暂停' : entry.continuation?.state === 'running' ? '正在核实外部任务结果' : '等待外部任务结果', ...(entry.enabled ? { retryAt: entry.nextRunAt } : {}) }
}
