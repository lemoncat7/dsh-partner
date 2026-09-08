import { randomUUID } from 'node:crypto'
import type { BoardRequirement } from './domain.js'

export function requirementDraft(title: string, description: string, ownerCompanionId?: string, creatorSessionId?: string): BoardRequirement {
  const now = Date.now()
  return { id: `requirement-${randomUUID()}`, title, description, status: 'planning', revision: 1, controlRevision: 1, createdAt: now, updatedAt: now,
    ...(ownerCompanionId ? { ownerCompanionId } : {}), ...(creatorSessionId ? { creatorSessionId } : {}) }
}
