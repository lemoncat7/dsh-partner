import type { PartnerInboxStore } from '../notifications/store.js'

/** Startup-only, local system notice. No model, channel delivery or directory scan. */
export function syncStorageNotice(inbox: PartnerInboxStore, current: number, target: number): void {
  const id = `system:storage-migration:${target}`
  const pending = current < target
  const previous = inbox.snapshot().items.filter(item => item.kind === 'system' && item.action === 'storage-migration')
  inbox.remove(previous.filter(item => !pending || item.id !== id).map(item => item.id))
  if (!pending) return
  inbox.append({ id, kind: 'system', action: 'storage-migration', companionId: '', companionName: '伙伴插件',
    title: '需要升级数据目录',
    summary: `当前存储版本 **${current}**，可升级到 **${target}**。\n\n升级会整理公共数据及各伙伴的私有目录。请先备份，再进入「设置 → 基本设置 → 升级迁移」检查并确认。\n\n**不会自动迁移**，点击下方「前往升级迁移」打开设置。`, createdAt: Date.now() })
}
