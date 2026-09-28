export interface AttachmentStorageItem {
  id: string
  companionId: string
  companionName: string
  name: string
  size: number
  createdAt: number
  channel: 'pending' | 'sent' | 'failed' | 'none'
  protectedReason?: string
}
export interface AttachmentStorageView {
  limitMiB: number
  usedBytes: number
  count: number
  eligibleBytes: number
  eligibleCount: number
  filteredCount: number
  items: AttachmentStorageItem[]
  owners: Array<{ id: string; name: string; bytes: number; count: number; directory: string }>
}
export interface AttachmentCleanupResult {
  removed: number
  freedBytes: number
  skipped: number
  failed: number
}
