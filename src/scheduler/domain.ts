export type ScheduleOverlapPolicy = 'skip' | 'queue'

export interface ScheduledPartnerTask {
  id: string
  companionId: string
  title: string
  prompt: string
  schedule: { kind: 'interval'; minutes: number } | { kind: 'daily'; hour: number; minute: number } | { kind: 'once'; at: number }
  continuation?: ScheduleContinuation
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

export interface ScheduleContinuation {
  board?: { taskId: string; delegationId: string; workRevision: number }
  taskKey: string
  externalTaskId: string
  originSessionId: string
  originChannel?: { routeId: string; channelId: string; userId: string }
  check: string
  nextStep: string
  completion?: string
  state: 'waiting' | 'running' | 'completed' | 'blocked' | 'cancelled'
  attempts: number
  checks?: number
  dispatchedAt?: number
  maxAttempts: number
  deadlineAt: number
  runToken?: string
  summary?: string
  notifiedAt?: number
  nextNotifyAt?: number
  messageId?: string
  finalReply?: { key: string; text: string; referenceTexts: string[]; notifiedAt?: number; nextNotifyAt?: number }
}
