import type { ConversationTurn, MemoryCandidate } from './memory-domain.js'

const normalized = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** Ground model proposals in user speech, never in assistant summaries. */
export function groundMemoryCandidates(candidates: MemoryCandidate[], turns: ConversationTurn[]): MemoryCandidate[] {
  return candidates.flatMap(candidate => {
    const quote = normalized(candidate.evidenceQuote ?? '')
    if (quote.length < 2) return []
    const matches = turns.filter(turn => (!candidate.sourceTurnId || turn.id === candidate.sourceTurnId)
      && normalized(turn.user).includes(quote))
    if (matches.length !== 1) return []
    const source = matches[0]!
    return [{ ...candidate, sourceEvidence: { turnId: source.id, at: source.at, excerpt: quote.slice(0, 300) } }]
  })
}
