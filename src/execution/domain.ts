export type ExecutionKind = 'schedule' | 'delegation' | 'skill'
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'timed-out'

export interface ExecutionRun {
  id: string
  kind: ExecutionKind
  ownerCompanionId: string
  sessionId: string
  sourceId: string
  status: ExecutionStatus
  destroyAfterRun: boolean
  startedAt: number
  completedAt?: number
  outputSummary?: string
  error?: string
  toolNames: string[]
}
