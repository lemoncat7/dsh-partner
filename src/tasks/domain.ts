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
  createdBy: 'user' | 'companion' | 'schedule'
  creatorCompanionId?: string
  skillIds: string[]
  relatedTaskIds: string[]
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
  kind: 'created' | 'updated' | 'moved' | 'assigned' | 'delegated' | 'commented' | 'completed' | 'failed'
  message: string
  at: number
}
