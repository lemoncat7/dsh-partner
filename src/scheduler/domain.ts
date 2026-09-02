export type ScheduleOverlapPolicy = 'skip' | 'queue'

export interface ScheduledPartnerTask {
  id: string
  companionId: string
  title: string
  prompt: string
  schedule: { kind: 'interval'; minutes: number } | { kind: 'daily'; hour: number; minute: number }
  enabled: boolean
  destroySessionAfterRun: boolean
  overlapPolicy: ScheduleOverlapPolicy
  timeoutMinutes: number
  nextRunAt: number
  lastRunAt?: number
  lastRunStatus?: 'completed' | 'failed' | 'skipped'
  createdAt: number
  updatedAt: number
}
