import type { PartnerMemory } from './memory-domain.js'

export function memoryTerms(value: string): string[] {
  const words = value.normalize('NFKC').toLocaleLowerCase().slice(0, 4000).match(/[a-z0-9_]+|\p{Script=Han}+/gu) ?? []
  return [...new Set(words.flatMap(word => /^\p{Script=Han}+$/u.test(word) && word.length > 2
    ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]))].slice(0, 80)
}

export function memoryRelevance(memory: Pick<PartnerMemory, 'subject' | 'content'>, terms: string[]): number {
  const haystack = `${memory.subject} ${memory.content}`.normalize('NFKC').toLocaleLowerCase()
  const matches = terms.filter(term => haystack.includes(term)).length
  return terms.length ? matches / terms.length : 0
}

export function rankMemories(memories: PartnerMemory[], query: string, now: number, relevantOnly = true): PartnerMemory[] {
  const terms = memoryTerms(query)
  return memories.map(item => {
    const lexical = memoryRelevance(item, terms)
    const recency = Math.max(0, 1 - (now - item.updatedAt) / (180 * 86_400_000))
    return { item, lexical, score: lexical * .5 + item.importance * .22 + item.confidence * .18 + recency * .1 }
  }).filter(entry => !relevantOnly || entry.lexical > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt).map(entry => entry.item)
}
