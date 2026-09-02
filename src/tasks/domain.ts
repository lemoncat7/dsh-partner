export const TASK_STATUSES = ['backlog', 'ready', 'doing', 'review', 'done', 'blocked'] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

export interface BoardTask {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assigneeCompanionId?: string
  reviewerCompanionId?: string
  createdBy: 'user' | 'companion' | 'schedule'
  creatorCompanionId?: string
  creatorSessionId?: string
  skillIds: string[]
  /** Tasks that must reach done before this task can start. */
  dependencyTaskIds: string[]
  resultSummary?: string
  reviewSummary?: string
  dueAt?: number
  revision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}
export interface TaskActivity {
  id: string
  taskId: string
  actor: 'user' | 'companion' | 'schedule' | 'system'
  actorCompanionId?: string
  kind: 'created' | 'updated' | 'moved' | 'assigned' | 'delegated' | 'commented' | 'result' | 'reviewed' | 'reopened' | 'completed' | 'failed' | 'retrying' | 'recovered'
  message: string
  at: number
}
