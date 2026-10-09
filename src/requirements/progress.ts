import { createHash } from 'node:crypto'
import type { PartnerState } from '../domain.js'
import type { BoardRequirement } from './domain.js'
import { recoveryPending } from '../tasks/blocked-recovery.js'

/** Ignore bookkeeping timestamps: unchanged deliverables must not produce new notifications. */
export function requirementProgressKey(state: PartnerState, item: BoardRequirement): string {
  const tasks = state.tasks.filter(t => t.requirementId === item.id).sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify([item.title, item.description, tasks.map(t =>
    [t.id, t.title, t.description, t.status, t.resultSummary, t.resultAbstract, t.rejectionReason, t.dependencyTaskIds, t.autoRun])])).digest('hex')
}

/** A gap between dependency dispatches is not the end of a work batch. */
export function requirementIsIdle(state: PartnerState, item: BoardRequirement): boolean {
  const tasks = state.tasks.filter(t => t.requirementId === item.id)
  if (!tasks.length || tasks.some(t => t.status !== 'done' && t.status !== 'blocked')) return false
  const ids = new Set(tasks.map(t => t.id))
  if (state.delegations.some(d => ids.has(d.taskId) && ['running', 'queued'].includes(d.status))) return false
  return true
}

/** A blocked dependency chain is stopped, not an ordinary dispatch gap. */
export function requirementCanReportStage(state: PartnerState, item: BoardRequirement): boolean {
  if (state.tasks.some(task => task.requirementId === item.id && recoveryPending(state, task))) return false
  if (requirementIsIdle(state, item)) return true
  const tasks = state.tasks.filter(task => task.requirementId === item.id)
  if (!tasks.some(task => task.status === 'blocked')) return false
  const ids = new Set(tasks.map(task => task.id))
  const blocked = new Set(state.tasks.filter(task => task.status === 'blocked').map(task => task.id))
  // Fixed point also handles malformed cycles without recursive/exponential walks.
  let changed = true
  while (changed) {
    changed = false
    for (const task of state.tasks) {
      if (!blocked.has(task.id) && task.status === 'ready' && task.autoRun && task.dependencyTaskIds.some(id => blocked.has(id))) {
        blocked.add(task.id); changed = true
      }
    }
  }
  if (state.delegations.some(d => ids.has(d.taskId) && (d.status === 'running' || (d.status === 'queued' &&
    !(blocked.has(d.taskId) && tasks.find(t => t.id === d.taskId)?.status === 'ready'))))) return false
  return tasks.every(task => task.status === 'done' || blocked.has(task.id))
}
