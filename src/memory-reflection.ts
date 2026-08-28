import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Companion } from './domain.js'
import { concernSubjectSimilarity, extractConcernResources, type ConcernCandidate, type ConcernWatchKind } from './concern-domain.js'
import type { ConversationTurn, DailyReviewResult, DailyReviewTarget, MemoryCandidate, MemoryKind, MemoryRelationKind, ReflectionResult } from './memory-domain.js'
import type { PartnerMemoryStore } from './memory-store.js'
import type { PartnerConcernStore } from './concern-store.js'

type ReflectionContext = Context & { llm: Context['llm']; agentDefaultModel: AgentDefaultModelConfig }

export class MemoryReflectionService {
  private readonly queues = new Map<string, Promise<void>>()
  constructor(private readonly ctx: ReflectionContext, private readonly store: PartnerMemoryStore, private readonly concerns: PartnerConcernStore) {}

  async reflect(companion: Companion, turn: ConversationTurn): Promise<void> {
    const key = `${companion.id}:${turn.scopeId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.run(companion, turn))
    this.queues.set(key, current)
    try { await current } finally { if (this.queues.get(key) === current) this.queues.delete(key) }
  }

  async reviewDay(companion: Companion, target: DailyReviewTarget): Promise<void> {
    const context = await this.store.dailyReviewContext(target)
    const concerns = (await this.concerns.list(companion.id, target.scopeId, false, 40)).map(concernContext)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ date: target.date, ...context, existingConcerns: concerns }) }], source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴每日记忆终审' } })],
        system: DAILY_REVIEW_SYSTEM, temperature: 0.05, maxTokens: 3000, signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(`daily review failed: ${chunk.reason.kind}`)
      }
    } finally { clearTimeout(timeout) }
    const result = parseDailyReview(output)
    await this.store.completeDailyReview(target, result)
    await this.concerns.applyCandidates(companion.id, target.scopeId, result.concerns, 'implicit')
  }

  private async run(companion: Companion, turn: ConversationTurn): Promise<void> {
    await this.store.archive(turn)
    const existing = await this.store.recall(companion.id, turn.scopeId, turn.user, 16)
    const diaries = await this.store.recentReflectionsForScope(companion.id, turn.scopeId, 1)
    const concerns = (await this.concerns.list(companion.id, turn.scopeId, false, 40)).map(concernContext)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: reflectionInput(this.store.day(turn.at), turn, existing, diaries.find(item => item.date === this.store.day(turn.at)), concerns) }], source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴记忆提炼' } })],
        system: REFLECTION_SYSTEM,
        temperature: 0.1,
        maxTokens: 1800,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(`memory reflection failed: ${chunk.reason.kind}`)
      }
    } finally { clearTimeout(timeout) }
    const result = parseReflection(output)
    await this.store.consolidate(turn, result)
    const resources = extractConcernResources(turn.user)
    const reflected = protectConcernDirective(result.concerns, turn.concernDirective)
    const candidates = resources.length === 0 ? reflected : reflected.map(item => item.operation === 'upsert' ? { ...item, resources } : item)
    await this.concerns.applyCandidates(companion.id, turn.scopeId, candidates, explicitConcernDirective(turn.user) ? 'explicit' : 'implicit', turn.at)
    if (turn.concernDirective !== undefined) await this.concerns.act(companion.id, turn.concernDirective.concernId, turn.concernDirective.action, turn.at)
    await this.store.prune(companion.id, companion.automation.memory.retentionDays)
  }
}

export function protectConcernDirective(
  candidates: ConcernCandidate[],
  directive: ConversationTurn['concernDirective'],
): ConcernCandidate[] {
  return directive === undefined
    ? candidates
    : candidates.filter(item => item.operation !== 'upsert' || concernSubjectSimilarity(item.subject, directive.subject) < .74)
}

export function explicitConcernDirective(value: string): boolean {
  const text = value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  if (/(?:不要|不用|无需|别|取消|停止).{0,12}(?:关注|留意|盯着|跟进|惦记|记着)/u.test(text)) return false
  return /(?:请|麻烦|帮我|替我|让(?:伙伴|你)?).{0,24}(?:关注|留意|盯着|跟进|惦记|记着)/u.test(text)
    || /(?:关注|留意|盯着|跟进|惦记).{0,24}(?:一下|这件事|这个|这些)/u.test(text)
    || /(?:keep\s+an?\s+eye\s+on|watch|track|follow).{0,80}(?:for\s+me|this|these)/iu.test(text)
}

function modelSelection(ctx: ReflectionContext, companion: Companion): { provider: string; model: string } {
  return {
    ...ctx.agentDefaultModel.currentSelection(),
    ...(companion.provider ? { provider: companion.provider } : {}), ...(companion.model ? { model: companion.model } : {}),
    ...(companion.automation.memory.provider ? { provider: companion.automation.memory.provider } : {}),
    ...(companion.automation.memory.model ? { model: companion.automation.memory.model } : {}),
  }
}

const REFLECTION_SYSTEM = `你是长期伙伴的记忆整理器。你不回答用户，只从有证据的对话中维护每日回顾和结构化记忆。
只输出一个 JSON 对象，不要 Markdown。格式：
{"daily":{"summary":"当天截至当前的简洁总结","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[{"kind":"profile|preference|task|event|relationship|emotion","subject":"稳定且简短的索引主题","content":"带场景边界的准确内容","confidence":0.0,"importance":0.0,"operation":"upsert|complete|remove","expiresInDays":3}],"concerns":[{"subject":"尚未闭环的具体事情","reason":"为什么伙伴应该继续惦记","operation":"upsert|resolve|dismiss","priority":0.0,"confidence":0.0,"watchKind":"auto|knowledge|workspace|web","watchQuery":"用于观察变化的具体对象或问题"}]}
规则：
1. 不把寒暄、模型猜测、助手自述当成用户事实；没有长期价值时 memories 返回空数组。
2. 偏好必须保留适用场景和例外；任务只记录用户明确提出或双方明确承诺的事项。
3. emotion 只是短期信号，必须设置 1-7 天过期，不做心理诊断。
4. 与已有记忆同主题时沿用 subject；用户纠正旧理解时用 upsert 更新，撤销时 remove，任务完成时 complete。
5. concerns 只表示尚未闭环且值得伙伴继续惦记的具体事情，例如持续未解决、临时方案、等待外部结果、反复不满意或用户明确要求留意；长期身份、普通偏好、宽泛兴趣和已经完成的事项不能成为挂念。
6. 用户说“继续留意、很重要、已经解决、不用管了”时，应对同一 subject 分别 upsert、提高 priority、resolve 或 dismiss。watchKind 按变化来源选择，不能把本地项目问题默认标为 web。
7. daily 应综合已有当日日记与新对话，不能只复述最后一句。数组每类最多 20 条，记忆候选最多 12 条。`

const DAILY_REVIEW_SYSTEM = `你是长期伙伴的每日记忆终审器。根据当天完整对话、滚动回顾和已有记忆，输出一次最终整理，不回答用户。
只输出 JSON：{"daily":{"summary":"","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[与逐轮提炼相同的候选格式],"concerns":[与逐轮提炼相同的挂念格式],"relations":[{"sourceSubject":"必须等于已有或候选记忆主题","targetSubject":"必须等于已有或候选记忆主题","kind":"supports|depends_on|about|conflicts_with|follows","label":"简短关系说明","confidence":0.0}]}
要求：合并重复理解；以完整对话纠正逐轮偏差；明确任务完成状态；复核并关闭已经完成或失效的挂念；不创造对话中没有的事实；关系必须有证据且最多 80 条；无可靠内容时对应数组返回空数组。`

function reflectionInput(date: string, turn: ConversationTurn, memories: unknown[], diary: unknown, concerns: unknown[]): string {
  return JSON.stringify({ date, existingDailyReflection: diary ?? null, existingRelevantMemories: memories, existingConcerns: concerns, newTurn: { id: turn.id, user: turn.user, assistant: turn.assistant } })
}

function concernContext(item: Awaited<ReturnType<PartnerConcernStore['list']>>[number]): Record<string, unknown> {
  return { id: item.id, subject: item.subject, reason: item.reason, origin: item.origin, state: item.state, priority: item.priority, watchKind: item.watchKind, updatedAt: item.updatedAt }
}

export function parseReflection(raw: string): ReflectionResult {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) throw new Error('memory reflection returned no JSON object')
  const value = JSON.parse(match[0]) as Record<string, unknown>
  const daily = record(value.daily)
  const memories = Array.isArray(value.memories) ? value.memories.map(parseCandidate).filter((item): item is MemoryCandidate => item !== undefined).slice(0, 12) : []
  const concerns = Array.isArray(value.concerns)
    ? value.concerns.map(parseConcern).filter((item): item is ConcernCandidate => item !== undefined)
    : []
  return {
    daily: {
      summary: string(daily.summary, 1200), events: stringArray(daily.events), openTasks: stringArray(daily.openTasks),
      completedTasks: stringArray(daily.completedTasks), learnings: stringArray(daily.learnings),
    },
    memories,
    concerns,
  }
}

function parseConcern(value: unknown): ConcernCandidate | undefined {
  const item = record(value)
  if (item.operation !== 'upsert' && item.operation !== 'resolve' && item.operation !== 'dismiss') return undefined
  const subject = string(item.subject, 300)
  const watchKind = item.watchKind
  if (!subject || !isWatchKind(watchKind)) return undefined
  return {
    subject, reason: string(item.reason, 800), operation: item.operation,
    priority: number(item.priority), confidence: number(item.confidence), watchKind,
    watchQuery: string(item.watchQuery, 500) || subject,
  }
}

function isWatchKind(value: unknown): value is ConcernWatchKind { return value === 'auto' || value === 'knowledge' || value === 'workspace' || value === 'web' }

export function parseDailyReview(raw: string): DailyReviewResult {
  const base = parseReflection(raw)
  const match = raw.trim().match(/\{[\s\S]*\}/)
  const value = match ? JSON.parse(match[0]) as Record<string, unknown> : {}
  const relations = Array.isArray(value.relations) ? value.relations.flatMap(item => {
    const relation = record(item); const kind = relation.kind
    if (!isRelationKind(kind)) return []
    const sourceSubject = string(relation.sourceSubject, 120); const targetSubject = string(relation.targetSubject, 120)
    if (!sourceSubject || !targetSubject) return []
    return [{ sourceSubject, targetSubject, kind, label: string(relation.label, 120), confidence: number(relation.confidence) }]
  }).slice(0, 80) : []
  return { ...base, relations }
}

function isRelationKind(value: unknown): value is MemoryRelationKind { return value === 'supports' || value === 'depends_on' || value === 'about' || value === 'conflicts_with' || value === 'follows' }

function parseCandidate(value: unknown): MemoryCandidate | undefined {
  const item = record(value)
  const kind = item.kind
  const operation = item.operation
  if (!isKind(kind) || (operation !== 'upsert' && operation !== 'complete' && operation !== 'remove')) return undefined
  const subject = string(item.subject, 120)
  const content = string(item.content, 800)
  if (!subject || (operation === 'upsert' && !content)) return undefined
  const candidate: MemoryCandidate = {
    kind, operation, subject, content,
    confidence: number(item.confidence), importance: number(item.importance),
  }
  if (kind === 'emotion') candidate.expiresInDays = Math.min(7, Math.max(1, Math.round(finite(item.expiresInDays, 3))))
  else if (typeof item.expiresInDays === 'number' && item.expiresInDays > 0) candidate.expiresInDays = Math.min(3650, Math.round(item.expiresInDays))
  return candidate
}

function isKind(value: unknown): value is MemoryKind { return value === 'profile' || value === 'preference' || value === 'task' || value === 'event' || value === 'relationship' || value === 'emotion' }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function string(value: unknown, max: number): string { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.slice(0, max) }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(item => string(item, 240)).filter(Boolean))].slice(0, 20) : [] }
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5 }
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
