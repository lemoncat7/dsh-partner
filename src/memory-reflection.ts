import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Companion } from './domain.js'
import type { ConversationTurn, DailyReviewResult, DailyReviewTarget, MemoryCandidate, MemoryKind, MemoryRelationKind, ReflectionResult } from './memory-domain.js'
import type { PartnerMemoryStore } from './memory-store.js'

type ReflectionContext = Context & { llm: Context['llm']; agentDefaultModel: AgentDefaultModelConfig }

export class MemoryReflectionService {
  private readonly queues = new Map<string, Promise<void>>()
  constructor(private readonly ctx: ReflectionContext, private readonly store: PartnerMemoryStore) {}

  async reflect(companion: Companion, turn: ConversationTurn): Promise<void> {
    const key = `${companion.id}:${turn.scopeId}`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => this.run(companion, turn))
    this.queues.set(key, current)
    try { await current } finally { if (this.queues.get(key) === current) this.queues.delete(key) }
  }

  async reviewDay(companion: Companion, target: DailyReviewTarget): Promise<void> {
    const context = await this.store.dailyReviewContext(target)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ date: target.date, ...context }) }], source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴每日记忆终审' } })],
        system: DAILY_REVIEW_SYSTEM, temperature: 0.05, maxTokens: 3000, signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(`daily review failed: ${chunk.reason.kind}`)
      }
    } finally { clearTimeout(timeout) }
    await this.store.completeDailyReview(target, parseDailyReview(output))
  }

  private async run(companion: Companion, turn: ConversationTurn): Promise<void> {
    await this.store.archive(turn)
    const existing = await this.store.recall(companion.id, turn.scopeId, turn.user, 16)
    const diaries = await this.store.recentReflectionsForScope(companion.id, turn.scopeId, 1)
    const selection = modelSelection(this.ctx, companion)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    let output = ''
    try {
      for await (const chunk of this.ctx.llm.stream({
        ...selection,
        messages: [createUserMessage({ content: [{ type: 'text', text: reflectionInput(this.store.day(turn.at), turn, existing, diaries.find(item => item.date === this.store.day(turn.at))) }], source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴记忆提炼' } })],
        system: REFLECTION_SYSTEM,
        temperature: 0.1,
        maxTokens: 1800,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(`memory reflection failed: ${chunk.reason.kind}`)
      }
    } finally { clearTimeout(timeout) }
    await this.store.consolidate(turn, parseReflection(output))
    await this.store.prune(companion.id, companion.automation.memory.retentionDays)
  }
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
{"daily":{"summary":"当天截至当前的简洁总结","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[{"kind":"profile|preference|task|event|relationship|emotion","subject":"稳定且简短的索引主题","content":"带场景边界的准确内容","confidence":0.0,"importance":0.0,"operation":"upsert|complete|remove","expiresInDays":3}]}
规则：
1. 不把寒暄、模型猜测、助手自述当成用户事实；没有长期价值时 memories 返回空数组。
2. 偏好必须保留适用场景和例外；任务只记录用户明确提出或双方明确承诺的事项。
3. emotion 只是短期信号，必须设置 1-7 天过期，不做心理诊断。
4. 与已有记忆同主题时沿用 subject；用户纠正旧理解时用 upsert 更新，撤销时 remove，任务完成时 complete。
5. daily 应综合已有当日日记与新对话，不能只复述最后一句。数组每类最多 20 条，记忆候选最多 12 条。`

const DAILY_REVIEW_SYSTEM = `你是长期伙伴的每日记忆终审器。根据当天完整对话、滚动回顾和已有记忆，输出一次最终整理，不回答用户。
只输出 JSON：{"daily":{"summary":"","events":[],"openTasks":[],"completedTasks":[],"learnings":[]},"memories":[与逐轮提炼相同的候选格式],"relations":[{"sourceSubject":"必须等于已有或候选记忆主题","targetSubject":"必须等于已有或候选记忆主题","kind":"supports|depends_on|about|conflicts_with|follows","label":"简短关系说明","confidence":0.0}]}
要求：合并重复理解；以完整对话纠正逐轮偏差；明确任务完成状态；不创造对话中没有的事实；关系必须有证据且最多 80 条；无可靠关系时返回空数组。`

function reflectionInput(date: string, turn: ConversationTurn, memories: unknown[], diary: unknown): string {
  return JSON.stringify({ date, existingDailyReflection: diary ?? null, existingRelevantMemories: memories, newTurn: { id: turn.id, user: turn.user, assistant: turn.assistant } })
}

export function parseReflection(raw: string): ReflectionResult {
  const match = raw.trim().match(/\{[\s\S]*\}/)
  if (!match) throw new Error('memory reflection returned no JSON object')
  const value = JSON.parse(match[0]) as Record<string, unknown>
  const daily = record(value.daily)
  const memories = Array.isArray(value.memories) ? value.memories.map(parseCandidate).filter((item): item is MemoryCandidate => item !== undefined).slice(0, 12) : []
  return {
    daily: {
      summary: string(daily.summary, 1200), events: stringArray(daily.events), openTasks: stringArray(daily.openTasks),
      completedTasks: stringArray(daily.completedTasks), learnings: stringArray(daily.learnings),
    },
    memories,
  }
}

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
