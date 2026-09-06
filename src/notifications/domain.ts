export interface PartnerNotice {
  id: string
  kind: 'reply' | 'task' | 'schedule'
  companionId: string
  companionName: string
  title: string
  summary: string
  createdAt: number
  readAt?: number
  routeId?: string
  sessionId?: string
  taskId?: string
}
export interface PartnerInbox { items: PartnerNotice[]; unread: number }
