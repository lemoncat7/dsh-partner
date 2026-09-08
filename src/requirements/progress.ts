import { createHash } from 'node:crypto'
import type { PartnerState } from '../domain.js'
import type { BoardRequirement } from './domain.js'

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
