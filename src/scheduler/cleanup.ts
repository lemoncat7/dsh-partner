import type { PartnerState } from '../domain.js'

/** Never discard an undelivered final reply or a receipt still needed by board resumption. */
export function cleanupObsoleteSchedules(state: PartnerState, now = Date.now()): void {
  const removed = new Set<string>()
  state.schedules = state.schedules.filter(entry => {
    const wake = entry.continuation
    let obsolete = false
    if (entry.boardTaskId) {
      const task = state.tasks.find(t => t.id === entry.boardTaskId)
      obsolete = !task || task.status === 'done'
    }
    if (wake && !entry.enabled && (!wake.finalReply || wake.finalReply.notifiedAt)) {
      const task = wake.board ? state.tasks.find(t => t.id === wake.board!.taskId) : undefined
      obsolete ||= Boolean(wake.board && (!task || task.status === 'done'))
      // Keep a short grace period for in-flight receipt readers and cancellation observers.
      obsolete ||= wake.state === 'cancelled' && now - entry.updatedAt >= 60_000
    }
    if (obsolete) removed.add(entry.id)
    return !obsolete
  })
  for (const job of state.delegations) if (job.continuationScheduleId && removed.has(job.continuationScheduleId)) delete job.continuationScheduleId
}
