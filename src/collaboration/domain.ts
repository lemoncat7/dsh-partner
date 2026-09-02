export type DelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type DelegationKind = 'task' | 'review'

export interface PartnerDelegation {
  id: string
  /** Missing on legacy records and therefore treated as a task delegation. */
  kind?: DelegationKind
  taskId: string
  initiatedBy: 'user' | 'companion'
  fromCompanionId?: string
  toCompanionId: string
  request: string
  status: DelegationStatus
  attempts?: number
  nextAttemptAt?: number
  lastAttemptAt?: number
  parentSessionId?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  resultSummary?: string
  executionRunId?: string
  error?: string
}

export function delegationKind(value: PartnerDelegation): DelegationKind { return value.kind ?? 'task' }
export function delegationPending(value: PartnerDelegation): boolean { return value.status === 'queued' || value.status === 'running' }
export interface PartnerDirectoryEntry {
  id: string
  name: string
  role: string
  description: string
  capabilities: string[]
  enabledSkills: Array<{ id: string; name: string }>
  availability: 'available' | 'busy' | 'offline'
}
