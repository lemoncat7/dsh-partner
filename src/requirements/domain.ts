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
}
