export type ConcernOrigin = 'explicit' | 'implicit'
export type ConcernState = 'active' | 'watching' | 'snoozed' | 'resolved' | 'archived'
export type ConcernWatchKind = 'auto' | 'knowledge' | 'workspace' | 'web'
export type ObservationDecision = 'drop' | 'remember' | 'defer' | 'feed' | 'notify'
export type ConcernResourceKind = 'file' | 'knowledge'

export interface ConcernResource {
  kind: ConcernResourceKind
  locator: string
  label: string
}

export interface PartnerConcern {
  id: string
  companionId: string
  scopeId: string
  subject: string
  reason: string
  origin: ConcernOrigin
  state: ConcernState
  priority: number
  confidence: number
  score: number
  watchKind: ConcernWatchKind
  watchQuery: string
  resources: ConcernResource[]
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  nextCheckAt: number
  lastCheckedAt?: number
  lastMentionedAt?: number
  resolvedAt?: number
}

export interface ConcernCandidate {
  subject: string
  reason: string
  operation: 'upsert' | 'resolve' | 'dismiss'
  priority: number
  confidence: number
  watchKind: ConcernWatchKind
  watchQuery: string
  resources?: ConcernResource[]
}

export interface ConcernObservationCandidate {
  concernId: string
  changed: boolean
  event: string
  evidence: string
  source: string
  relevance: number
  confidence: number
  actionability: number
}

export interface ConcernObservation {
  id: string
  concernId: string
  companionId: string
  scopeId: string
  fingerprint: string
  event: string
  evidence: string
  source: string
  novelty: number
  relevance: number
  confidence: number
  actionability: number
  interruptScore: number
  decision: ObservationDecision
  createdAt: number
  mentionedAt?: number
}

export interface ConcernActivity {
  concerns: PartnerConcern[]
  observations: ConcernObservation[]
}

export function concernInterval(priority: number, origin: ConcernOrigin): number {
  const hours = priority >= .85 ? 3 : priority >= .65 ? 8 : priority >= .4 ? 24 : 72
  return hours * 3_600_000 * (origin === 'explicit' ? .75 : 1)
}

export function concernDecay(score: number, lastActivityAt: number, now: number, origin: ConcernOrigin): number {
  if (origin === 'explicit') return score
  const inactiveDays = Math.max(0, (now - lastActivityAt) / 86_400_000)
  return clamp(score * Math.exp(-inactiveDays / 30))
}

export function interruptDecision(input: {
  priority: number
  concernConfidence: number
  observationConfidence: number
  relevance: number
  novelty: number
  actionability: number
  recentlyMentioned: boolean
  firstObservation: boolean
  userRecentlyActive?: boolean
}): { score: number; decision: ObservationDecision } {
  if (input.observationConfidence < .45 || input.relevance < .35) return { score: 0, decision: 'drop' }
  let score = input.priority * .24
    + input.concernConfidence * .13
    + input.observationConfidence * .17
    + input.relevance * .2
    + input.novelty * .12
    + input.actionability * .14
  if (input.recentlyMentioned) score -= .24
  if (input.firstObservation) score -= .18
  if (input.userRecentlyActive) score -= .12
  score = clamp(score)
  return {
    score,
    decision: score >= .82 ? 'notify' : score >= .64 ? 'feed' : score >= .42 ? 'defer' : 'remember',
  }
}

export function normalizeConcernSubject(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function focusedConcernQuery(value: string): string {
  return value.normalize('NFKC')
    .replace(/(?:请|麻烦|帮我|替我|让伙伴|让你|关注|留意|盯着|跟进|惦记|记着|帮忙看看)/gu, ' ')
    .replace(/[\/·｜|]+/gu, ' ')
    .replace(/[，。！？、；;,.!?：:()[\]{}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function extractConcernResources(value: string): ConcernResource[] {
  const resources: ConcernResource[] = []
  const knowledgeRanges: Array<[number, number]> = []
  for (const match of value.matchAll(/@知识库\[([^\]/]{1,100})(?:\/([^\]]{1,240}))?\]/gu)) {
    const token = match[0]
    const base = match[1]?.trim()
    if (!token || !base || match.index === undefined) continue
    const document = match[2]?.trim()
    knowledgeRanges.push([match.index, match.index + token.length])
    resources.push({ kind: 'knowledge', locator: document ? `${base}/${document}` : base, label: document ? `${base} · ${document}` : base })
  }
  for (const match of value.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s]+))/gu)) {
    const raw = (match[1] ?? match[2] ?? '').trim().replace(/[，。！？、；;,.!?]+$/u, '')
    const at = (match.index ?? 0) + (match[0]?.indexOf('@') ?? 0)
    if (!raw || raw.startsWith('知识库[') || knowledgeRanges.some(([start, end]) => at >= start && at < end)) continue
    const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '')
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || /(?:^|\/)(?:memory|concerns)(?:\/|$)/iu.test(normalized)) continue
    resources.push({ kind: 'file', locator: normalized.slice(0, 500), label: normalized.slice(0, 240) })
  }
  const seen = new Set<string>()
  return resources.filter(item => {
    const key = `${item.kind}\u0000${item.locator.toLocaleLowerCase('zh-CN')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

export function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : .5
}
