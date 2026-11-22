import type { PartnerMemory } from './memory-domain.js'

/** A correction and a replay cannot count as new support for a preference. */
export function preferenceEvidenceCount(memory: Pick<PartnerMemory,'kind'|'evidence'>): number {
  return memory.kind === 'preference' ? new Set(memory.evidence.filter(e => e.supportsCurrent !== false && e.excerpt.trim().length >= 2).map(e => e.turnId)).size : 0
}

export function preferenceEmphasisLabel(memory: Pick<PartnerMemory,'kind'|'evidence'>): string {
  const count=preferenceEvidenceCount(memory)
  return count>=3?'反复强调':count>=2?'多次确认':''
}
