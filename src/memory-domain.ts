import type { AppliedConcernLifecycleDirective, ConcernCandidate } from './concern-domain.js'

export type MemoryKind = 'profile' | 'preference' | 'task' | 'event' | 'relationship' | 'emotion'
export type MemoryStatus = 'active' | 'completed' | 'superseded' | 'expired'

export interface ConversationTurn {
  id: string
  companionId: string
  scopeId: string
  sessionId: string
  at: number
  user: string
  assistant: string
  concernDirective?: AppliedConcernLifecycleDirective
}

export interface MemoryEvidence {
  turnId: string
  at: number
  excerpt: string
}

export interface PartnerMemory {
  id: string
  companionId: string
  scopeId: string
  kind: MemoryKind
  subject: string
  content: string
  status: MemoryStatus
  confidence: number
  importance: number
  createdAt: number
  updatedAt: number
  expiresAt?: number
  locked?: boolean
  evidence: MemoryEvidence[]
}

export interface UserProfileSnapshot {
  companionId: string
  scopeId: string
  version: string
  updatedAt?: number
  entries: PartnerMemory[]
  evidenceCount: number
  lockedCount: number
}

export interface MemoryRecallContext {
  profile: UserProfileSnapshot
  relevant: PartnerMemory[]
}

export interface DailyReflection {
  date: string
  companionId: string
  scopeId: string
  summary: string
  events: string[]
  openTasks: string[]
  completedTasks: string[]
  learnings: string[]
  updatedAt: number
  turnCount: number
}

export interface MemoryCandidate {
  kind: MemoryKind
  subject: string
  content: string
  confidence: number
  importance: number
  operation: 'upsert' | 'complete' | 'remove'
  expiresInDays?: number
}

export interface ReflectionResult {
  daily: Pick<DailyReflection, 'summary' | 'events' | 'openTasks' | 'completedTasks' | 'learnings'>
  memories: MemoryCandidate[]
  concerns: ConcernCandidate[]
}

export type MemoryRelationKind = 'supports' | 'depends_on' | 'about' | 'conflicts_with' | 'follows'
export interface MemoryRelation {
  id: string
  companionId: string
  scopeId: string
  sourceMemoryId: string
  targetMemoryId: string
  kind: MemoryRelationKind
  label: string
  confidence: number
  updatedAt: number
}

export interface DailyReviewTarget { companionId: string; scopeId: string; date: string; attempts: number }
export interface DailyReviewResult extends ReflectionResult {
  relations: Array<{ sourceSubject: string; targetSubject: string; kind: MemoryRelationKind; label: string; confidence: number }>
}
