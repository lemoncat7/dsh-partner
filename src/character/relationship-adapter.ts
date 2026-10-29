import type { CompanionIdentity } from '../companions/identity.js'

/** A channel supplies verified audience metadata, never a nickname or model guess. */
export type IdentityAudience = { channel: 'default' } | { channel: 'qq'; matched: boolean }
export interface RelationshipAdapter {
  includesRelationship(audience: IdentityAudience): boolean
}
export const defaultRelationshipAdapter: RelationshipAdapter = { includesRelationship: () => true }
export const qqRelationshipAdapter: RelationshipAdapter = {
  includesRelationship: audience => audience.channel === 'qq' && audience.matched,
}
export function includesRelationship(audience: IdentityAudience): boolean {
  return (audience.channel === 'qq' ? qqRelationshipAdapter : defaultRelationshipAdapter).includesRelationship(audience)
}
/** Explicit empty text clears the old relationship too; old human drafts remain intact. */
export function relationshipTextForIdentity(identity: Pick<CompanionIdentity, 'relationshipText' | 'characterCard'>): string {
  return (identity.relationshipText ?? (identity.characterCard?.enabled ? identity.characterCard.relationship : '') ?? '').trim()
}
export function renderIdentityRelationship(identity: Pick<CompanionIdentity, 'relationshipText' | 'characterCard'>, audience: IdentityAudience = { channel: 'default' }): string {
  if (!includesRelationship(audience)) return ''
  const text = relationshipTextForIdentity(identity)
  return text ? `【与本轮交流对象的关系设定】\n${text}\n关系决定称呼与相处方式，不改变角色自身性格或工具权限；设定中的经历不等于已发生的真实事件。` : ''
}
