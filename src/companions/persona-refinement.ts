import type { Companion, PartnerState } from '../domain.js'
import { type CompanionIdentity } from './identity.js'

export interface PersonaRevision {
  at: number
  reason: string
  before: Partial<CompanionIdentity>
  after: Partial<CompanionIdentity>
}
/** Only self-description, never policy, user relationship or delivery settings. */
export function applyPersonaRefinement(state: PartnerState, companion: Companion, raw: unknown, expectedAt: unknown, reason: unknown): void {
  throw Error('自主调整角色设定已停用，请使用自主习惯；固定角色正文不自动改写')
}
