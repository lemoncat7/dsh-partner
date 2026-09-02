export type DelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface PartnerDelegation {
  id: string
  taskId: string
  fromCompanionId: string
  toCompanionId: string
  request: string
  status: DelegationStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  resultSummary?: string
  executionRunId?: string
  error?: string
}
export interface PartnerDirectoryEntry {
  id: string
  name: string
  role: string
  description: string
  capabilities: string[]
  enabledSkills: Array<{ id: string; name: string }>
  availability: 'available' | 'busy' | 'offline'
}
