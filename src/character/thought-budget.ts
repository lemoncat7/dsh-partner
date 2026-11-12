import type { Companion, PartnerState } from '../domain.js'
import type { CompanionThought } from './thoughts.js'

export const MAX_ACTIVE_THOUGHTS = 12
export const MAX_RETAINED_THOUGHTS = 64

export function thoughtPriority(t: CompanionThought, now = Date.now()): number {
  const freshness = 1 / (1 + Math.max(0, now - t.sourceAt) / 86400000)
  const repetition = 1 / (1 + t.attempts * 0.5)
  const recency = t.lastConsideredAt ? Math.min(1, Math.max(0, now - t.lastConsideredAt) / 3600000) : 1
  return freshness * repetition * (0.05 + 0.95 * recency)
}

/** One budget per companion, across all routes and every writer. No messages or task completion. */
export function enforceThoughtBudget(state: PartnerState, c: Companion, now = Date.now()): void {
  const thoughts = c.thoughts
  if (!thoughts) return
  const protectedIds = new Set<string>()
  if (c.activityPlan?.thoughtId && c.activityPlan.status !== 'cancelled') protectedIds.add(c.activityPlan.thoughtId)
  for (const route of state.sessions) {
    const active = route.idleContactState
    if (route.companionId === c.id && active?.thoughtId && !active.cancelled &&
        !c.activityJournal?.some(row => row.id === active.messageId)) protectedIds.add(active.thoughtId)
  }
  const ranked = thoughts.filter(t => t.status === 'open').sort((a, b) =>
    Number(protectedIds.has(b.id)) - Number(protectedIds.has(a.id)) ||
    thoughtPriority(b, now) - thoughtPriority(a, now) || b.sourceAt - a.sourceAt || a.id.localeCompare(b.id))
  for (const t of ranked.slice(MAX_ACTIVE_THOUGHTS)) {
    t.status = 'dismissed'
    t.capacityArchivedAt = now
    t.updatedAt = now
  }
  for (const t of ranked.slice(0, MAX_ACTIVE_THOUGHTS)) delete t.capacityArchivedAt
  if (thoughts.length > MAX_RETAINED_THOUGHTS) {
    const remove = new Set(thoughts.filter(t => t.status !== 'open')
      .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)
      .slice(0, thoughts.length - MAX_RETAINED_THOUGHTS).map(t => t.id))
    c.thoughts = thoughts.filter(t => !remove.has(t.id))
  }
}
