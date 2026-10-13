import type { PartnerConcern } from './concern-domain.js'

export type ConcernControl = 'auto' | 'pinned' | 'stopped'
export interface ConcernAdjustment { at: number; actor: 'user' | 'partner'; reason: string; priority: number; state: string }
export function concernStage(item: Pick<PartnerConcern, 'state' | 'priority'>): string {
  if (item.state === 'archived') return '已归档'
  if (item.state === 'resolved') return '已解决'
  return item.priority >= .8 ? '重点关注' : item.priority >= .4 ? '持续跟进' : '暂时观察'
}

export interface ConcernRevision {
  action: 'update' | 'archive' | 'resolve' | 'restore'
  reason: string
  priority?: number
  conclusion?: 'resolved' | 'expired' | 'irrelevant'
}

/** Attention belongs to the companion; explicit user controls always win. */
export function reviseConcern(item: PartnerConcern, change: ConcernRevision, now: number): PartnerConcern {
  if (!change.reason.trim() || change.reason.length > 800) throw new Error('请说明本次关注调整的原因（1–800 字），无需用户另行授权')
  if (change.priority !== undefined && (!Number.isFinite(change.priority) || change.priority < 0 || change.priority > 1)) throw new Error('关注度必须在 0–1 之间')
  if (item.control === 'stopped') throw new Error('用户已停止此关注，只有用户可恢复；请勿新建同主题绕过')
  const priority = change.priority ?? item.priority
  if (item.control === 'pinned' && (priority < item.priority || change.action === 'archive' || change.action === 'resolve')) throw new Error('用户已置顶此关注，伙伴不能降温或结束；用户可先取消置顶')
  let state = item.state
  if (change.action === 'resolve') state = 'resolved'
  else if (change.action === 'archive') {
    if (item.origin === 'explicit' && change.conclusion !== 'resolved' && change.conclusion !== 'expired') throw new Error('用户交代的关注仅在已解决或约定期限结束时归档；不能仅因沉默归档')
    state = 'archived'
  } else if (change.action === 'restore') state = 'watching'
  if ((state === 'watching' || state === 'active') && priority < .18 && item.origin === 'implicit' && item.control !== 'pinned') state = 'archived'
  const at = Math.max(now, item.updatedAt + 1)
  return { ...item, priority, state, updatedAt: at,
    adjustments: [...(item.adjustments ?? []), { at, actor: 'partner' as const, reason: change.reason.trim(), priority, state }].slice(-20),
  }
}
