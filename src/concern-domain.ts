export type ConcernOrigin = 'explicit' | 'implicit'
export type ConcernState = 'active' | 'watching' | 'snoozed' | 'resolved' | 'archived'
export type ConcernWatchKind = 'auto' | 'knowledge' | 'workspace' | 'web'
export type ObservationDecision = 'drop' | 'remember' | 'defer' | 'feed' | 'notify'
export type NotificationRuleEffect = 'auto' | 'notify' | 'suppress'
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

export const IMPLICIT_CONCERN_MIN_PRIORITY = .55
export const IMPLICIT_CONCERN_MIN_CONFIDENCE = .72
export const IMPLICIT_CONCERN_MIN_SCORE = .64
export const MAX_IMPLICIT_CONCERNS_PER_BATCH = 2

/**
 * Deterministic admission gate shared by reflection and AI tool suggestions.
 * The model proposes; this policy decides whether an implicit concern may be
 * persisted. Lifecycle operations remain available so stale concerns can be
 * closed even when a later model response has lower confidence.
 */
export function implicitConcernRejection(candidate: ConcernCandidate): string | undefined {
  if (candidate.operation !== 'upsert') return undefined
  const subjectLength = [...normalizeConcernSubject(candidate.subject)].length
  if (subjectLength < 4) return '关注主题过于宽泛'
  if ([...candidate.reason.trim()].length < 4) return '缺少继续关注的具体原因'
  if ([...candidate.watchQuery.trim()].length < 2) return '缺少可执行的观察目标'
  const priority = clamp(candidate.priority)
  const confidence = clamp(candidate.confidence)
  if (priority < IMPLICIT_CONCERN_MIN_PRIORITY) return '优先级不足'
  if (confidence < IMPLICIT_CONCERN_MIN_CONFIDENCE) return '证据置信度不足'
  if (priority * .55 + confidence * .45 < IMPLICIT_CONCERN_MIN_SCORE) return '综合关注分数不足'
  return undefined
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
  nextCheckInMinutes?: number
  notificationRuleEffect?: NotificationRuleEffect
  notificationRuleReason?: string
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
  notificationRuleEffect: NotificationRuleEffect
  notificationRuleReason: string
  decisionReason: string
  createdAt: number
  mentionedAt?: number
}

export interface ConcernActivity {
  concerns: PartnerConcern[]
  observations: ConcernObservation[]
}

export type ConcernLifecycleAction = 'ignore' | 'resolve'

export interface ConcernLifecycleRequest {
  action: ConcernLifecycleAction
  target: string
}

export interface AppliedConcernLifecycleDirective extends ConcernLifecycleRequest {
  concernId: string
  subject: string
}

export function concernInterval(priority: number, origin: ConcernOrigin): number {
  const hours = priority >= .85 ? 3 : priority >= .65 ? 8 : priority >= .4 ? 24 : 72
  return hours * 3_600_000 * (origin === 'explicit' ? .75 : 1)
}

export const MIN_CONCERN_CHECK_MINUTES = 30
export const MAX_CONCERN_CHECK_MINUTES = 30 * 24 * 60

export function boundedConcernCheckMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(MAX_CONCERN_CHECK_MINUTES, Math.max(MIN_CONCERN_CHECK_MINUTES, Math.round(value)))
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
  notificationRuleEffect?: NotificationRuleEffect
}): { score: number; decision: ObservationDecision; reason: string } {
  if (input.observationConfidence < .45 || input.relevance < .35) {
    return { score: 0, decision: 'drop', reason: '证据置信度或相关性不足' }
  }
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
  if (input.notificationRuleEffect === 'notify' && input.observationConfidence >= .75 && input.relevance >= .75) {
    return { score: Math.max(.82, score), decision: 'notify', reason: '命中关联知识文档中的明确提醒条件' }
  }
  if (input.notificationRuleEffect === 'suppress' && score >= .82) {
    return { score: .819, decision: 'feed', reason: '关联知识文档明确要求暂不主动提醒' }
  }
  const decision = score >= .82 ? 'notify' : score >= .64 ? 'feed' : score >= .42 ? 'defer' : 'remember'
  return {
    score,
    decision,
    reason: decision === 'notify' ? '打扰分数达到主动提醒阈值'
      : decision === 'feed' ? '变化进入伙伴动态，不主动打扰'
        : decision === 'defer' ? '变化与未来对话相关时顺带提及'
          : '变化仅静默记录',
  }
}

export function normalizeConcernSubject(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Parse only explicit, named lifecycle commands; ambiguous references remain model-assisted. */
export function concernLifecycleRequest(value: string): ConcernLifecycleRequest | undefined {
  const text = value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  if (!text || /[?？]\s*$/u.test(text) || /^(?:为什么|为何|怎么|怎会|是不是|是否|难道)/u.test(text)) return undefined
  const ignoreVerb = '(?:不|不要|不用|无需|别|取消|停止)(?:再|继续)?(?:关注|留意|盯着|盯|跟进|惦记|记着|巡检|巡查|观察|检查|管)'
  const leading = text.match(new RegExp(`^(?:(?:请|麻烦)[，,:： ]*)?(?:(?:我|你|伙伴)(?:现在|以后|也)?[，,:： ]*)?(?:让(?:伙伴|你)[，,:： ]*)?${ignoreVerb}(?:一下)?[，,:： ]*([^，。！？；;\\n]+)`, 'u'))
  const trailing = text.match(new RegExp(`^([^，。！？；;\\n]+?)[，,:： ]*(?:我|让(?:伙伴|你))?[，,:： ]*${ignoreVerb}(?:了|啦|吧)?$`, 'u'))
  const ignored = cleanLifecycleTarget(leading?.[1] ?? trailing?.[1] ?? '')
  if (ignored) return { action: 'ignore', target: ignored }

  const resolved = text.match(/^([^，。！？；;\n]+?)[，,:： ]*(?:已经|已)?(?:解决|完成|搞定|闭环)(?:了|啦|吧)?$/u)
  const resolvedTarget = cleanLifecycleTarget(resolved?.[1] ?? '')
  return resolvedTarget ? { action: 'resolve', target: resolvedTarget } : undefined
}

/** Conservative fuzzy score for a named command and an existing concern subject. */
export function concernSubjectSimilarity(leftValue: string, rightValue: string): number {
  const left = normalizeConcernSubject(leftValue.normalize('NFKC'))
  const right = normalizeConcernSubject(rightValue.normalize('NFKC'))
  if (!left || !right) return 0
  if (left === right) return 1
  const longest = Math.max(left.length, right.length)
  const containment = left.includes(right) || right.includes(left) ? Math.min(left.length, right.length) / longest : 0
  const subsequence = longestCommonSubsequence(left, right) / longest
  const pairs = bigramDice(left, right)
  return Math.max(containment, subsequence, pairs)
}

export function selectConcernLifecycleTarget(
  request: ConcernLifecycleRequest,
  concerns: readonly PartnerConcern[],
): PartnerConcern | undefined {
  const ranked = concerns
    .filter(item => item.state !== 'archived')
    .map(item => ({ item, score: concernSubjectSimilarity(request.target, item.subject) }))
    .filter(item => item.score >= .74)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
  const first = ranked[0]
  if (first === undefined) return undefined
  const second = ranked[1]
  if (first.score < 1 && second !== undefined && first.score - second.score < .1) return undefined
  return first.item
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

function cleanLifecycleTarget(value: string): string {
  const target = value
    .replace(/^[“”"'「」『』\s]+|[“”"'「」『』\s]+$/gu, '')
    .replace(/^(?:关于|对于|对|这个|这件事|那个)[，,:： ]*/u, '')
    .replace(/[，,:： ]*(?:了|啦|吧|就行|即可)$/u, '')
    .trim()
  return /^(?:这个|这件事|那个|它|这些|那件事)$/u.test(target) || normalizeConcernSubject(target).length < 2 ? '' : target.slice(0, 300)
}

function longestCommonSubsequence(left: string, right: string): number {
  const previous = new Uint16Array(right.length + 1)
  const current = new Uint16Array(right.length + 1)
  for (const leftCharacter of left) {
    current.fill(0)
    let column = 1
    for (const rightCharacter of right) {
      current[column] = leftCharacter === rightCharacter
        ? (previous[column - 1] ?? 0) + 1
        : Math.max(previous[column] ?? 0, current[column - 1] ?? 0)
      column += 1
    }
    previous.set(current)
  }
  return previous[right.length] ?? 0
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return 0
  const available = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2)
    available.set(pair, (available.get(pair) ?? 0) + 1)
  }
  let matches = 0
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2)
    const count = available.get(pair) ?? 0
    if (count <= 0) continue
    matches += 1
    available.set(pair, count - 1)
  }
  return (2 * matches) / (left.length + right.length - 2)
}
