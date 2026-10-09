import type { PartnerState } from '../domain.js'
import type { AttachmentDelivery, AttachmentDeliveryService } from '../attachments/service.js'
import type { BoardRequirement } from './domain.js'

/** Only explicitly submitted, accepted child deliverables cross the ownership boundary.
 * Legacy results may reference a deliveryId; arbitrary paths and review evidence do not. */
export async function requirementAttachments(item: BoardRequirement, state: PartnerState, service: AttachmentDeliveryService, selectedIds?: string[]): Promise<AttachmentDelivery[]> {
  const results = item.status === 'done' && item.results ? item.results : state.tasks.filter(t => t.requirementId === item.id && t.status === 'done')
  const selected = new Map<string, AttachmentDelivery>()
  for (const task of results) {
    const explicit = new Set(task.resultAttachmentIds ?? [])
    const legacy = [...[task.resultSummary, task.resultAbstract].filter(Boolean).join('\n').matchAll(/\bdeliveryId\s*[:：=]?\s*[`"']?([a-f0-9]{64})\b|\/attachments\/([a-f0-9]{64})\b/gi)].map(m => (m[1] ?? m[2])!.toLowerCase())
    for (const id of new Set([...explicit, ...legacy])) {
      if (selectedIds && !selectedIds.includes(id)) continue
      const file = service.get(id)
      if (!file) { if (explicit.has(id)) throw new Error(`任务交付附件不存在：${id}`); continue }
      if (file.companionId !== task.assigneeCompanionId) throw new Error('任务交付附件不属于执行伙伴，拒绝跨伙伴交付')
      if (!state.companions.some(c => c.id === file.companionId)) throw new Error('交付附件的执行伙伴已移除')
      await service.bytes(file)
      selected.set(file.hash, file)
    }
  }
  return [...selected.values()]
}
