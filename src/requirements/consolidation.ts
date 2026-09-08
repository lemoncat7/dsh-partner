import type { PartnerState } from '../domain.js'
import { appendBounded } from '../core/collections.js'
import { randomUUID } from 'node:crypto'
import { retainRequirementArchive } from './archive.js'
import { requirementProgressKey } from './progress.js'
import { advanceRequirementRevision } from './revisions.js'

/** Explicit maintenance only, never a title-based startup migration or an agent tool. */
export function consolidateCompletedRequirements(state: PartnerState, input: {
  targetId: string; sourceId: string; targetRevision: number; sourceRevision: number
  title: string; description: string
}): void {
  if (input.sourceId === input.targetId) throw new Error('不能合并同一需求')
  const target = state.requirements?.find(r => r.id === input.targetId)
  const source = state.requirements?.find(r => r.id === input.sourceId)
  if (!target) throw new Error('目标需求不存在')
  if (!source && target.archiveHistory?.some(h => h.requirementId === input.sourceId) && !state.tasks.some(t => t.requirementId === input.sourceId)) return
  if (!source) throw new Error('来源需求不存在')
  if (target.revision !== input.targetRevision || source.revision !== input.sourceRevision) throw new Error('需求已改变，请重新核对，未合并')
  if (target.status !== 'planning' || source.status !== 'done' || !source.notifiedAt) throw new Error('只合并已通知的完成需求到规划中的原需求')
  if (!target.ownerCompanionId || target.ownerCompanionId !== source.ownerCompanionId || !target.creatorSessionId || target.creatorSessionId !== source.creatorSessionId) throw new Error('不同负责人或来源会话的需求不能通过此修复合并')
  const children = state.tasks.filter(t => t.requirementId === source.id || t.requirementId === target.id)
  const ids = new Set(children.map(t => t.id))
  if (!children.some(t => t.requirementId === source.id) || children.some(t => t.status !== 'done') || state.delegations.some(d => ids.has(d.taskId) && ['running', 'queued'].includes(d.status))) throw new Error('任务尚未全部完成，不能合并')
  if (!input.title.trim() || input.title.length > 200 || input.description.length > 8000) throw new Error('合并后的需求说明无效')
  const oldBatchWasDelivered = Boolean(target.stageReport?.notifiedAt && target.stageReport.key === requirementProgressKey(state, target))
  retainRequirementArchive(target, source)
  const now = Date.now()
  for (const task of children.filter(t => t.requirementId === source.id)) {
    task.requirementId = target.id; task.revision++; task.updatedAt = now
    appendBounded(state.taskActivities, { id: `activity-${randomUUID()}`, taskId: task.id, actor: 'user', kind: 'updated',
      message: `修正续做归属：${source.id} → ${target.id}；保留已验收成果，不重新执行`, at: now }, 2000)
  }
  target.title = input.title.trim(); target.description = input.description
  advanceRequirementRevision(target, true)
  delete target.lastError; delete target.nextAttemptAt; delete target.attempts
  if (oldBatchWasDelivered) target.reportBaselineKey = requirementProgressKey(state, target)
  state.requirements = state.requirements!.filter(r => r.id !== source.id)
}
