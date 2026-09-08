import type { BoardTask } from '../tasks/domain.js'

export interface BoardRequirement {
  id: string
  title: string
  description: string
  ownerCompanionId?: string
  creatorSessionId?: string
  status: 'planning' | 'active' | 'review' | 'done'
  revision: number
  createdAt: number
  updatedAt: number
  summary?: string
  archivedAt?: number
  /** Immutable accepted deliverables survive deleting their original task cards. */
  results?: Array<Pick<BoardTask, 'id' | 'title' | 'assigneeCompanionId' | 'resultSummary' | 'resultAbstract'>>
  nextAttemptAt?: number
  attempts?: number
  lastError?: string
  notifiedAt?: number
  /** Durable stage receipt, independent of final archiving. */
  stageReport?: { key: string; summary: string; createdAt: number; notifiedAt?: number }
  /** Explicit continuation/migration must not announce the same delivered batch again. */
  reportBaselineKey?: string
  archiveHistory?: RequirementArchive[]
}

export interface RequirementArchive {
  requirementId: string
  title: string
  description: string
  revision: number
  summary?: string
  results?: BoardRequirement['results']
  archivedAt: number
  notifiedAt?: number
}
