import type { PartnerConcern } from './concern-domain.js'
import type { ConversationTurn, DailyReflection, MemoryRelationReviewContext, PartnerMemory } from './memory-domain.js'

export const REFLECTION_MEMORY_CHAR_BUDGET = 6_000
export const REFLECTION_CONCERN_CHAR_BUDGET = 3_500
export const DAILY_TURN_CHAR_BUDGET = 14_000
export const DAILY_MEMORY_CHAR_BUDGET = 8_000
export const DAILY_RELATION_CHAR_BUDGET = 4_000
export const DAILY_CONCERN_CHAR_BUDGET = 3_500

interface DailyReviewSource {
  reflection: DailyReflection
  memories: PartnerMemory[]
  existingRelations: MemoryRelationReviewContext[]
  turns: ConversationTurn[]
}

export function reflectionPromptInput(
  date: string,
  turn: ConversationTurn,
  memories: PartnerMemory[],
  diary: DailyReflection | undefined,
  concerns: PartnerConcern[],
): string {
  return JSON.stringify({
    date,
    existingDailyReflection: diary === undefined ? null : compactReflection(diary),
    existingRelevantMemories: compactMemories(memories, 16, REFLECTION_MEMORY_CHAR_BUDGET),
    existingConcerns: compactConcerns(concerns, 12, REFLECTION_CONCERN_CHAR_BUDGET),
    newTurn: compactTurn(turn, 6_000, 2_500),
  })
}

export function dailyReviewPromptInput(date: string, context: DailyReviewSource, concerns: PartnerConcern[]): string {
  return JSON.stringify({
    date,
    reflection: compactReflection(context.reflection),
    currentMemories: compactMemories(
      [...context.memories].sort((left, right) => right.updatedAt - left.updatedAt),
      24,
      DAILY_MEMORY_CHAR_BUDGET,
    ),
    existingRelations: compactRelations(context.existingRelations, 40, DAILY_RELATION_CHAR_BUDGET),
    turns: compactTurns(context.turns, DAILY_TURN_CHAR_BUDGET),
    existingConcerns: compactConcerns(concerns, 20, DAILY_CONCERN_CHAR_BUDGET),
    contextPolicy: '上下文经过无损索引和有界文本压缩；所有轮次均保留。未列出的旧记忆与旧关系由存储层继续保留。',
  })
}

export function compactMemories(memories: PartnerMemory[], limit: number, charBudget: number): Array<Record<string, unknown>> {
  const selected = memories.slice(0, limit)
  return fitEntries(selected, charBudget, (memory, entryBudget) => {
    const latest = memory.evidence.at(-1)
    const base: Record<string, unknown> = {
      id: memory.id,
      kind: memory.kind,
      subject: clip(memory.subject, 120),
      confidence: precision(memory.confidence),
      importance: precision(memory.importance),
      evidenceCount: memory.evidence.length,
      ...(memory.locked ? { locked: true } : {}),
    }
    return fitTextFields(base, entryBudget, [
      ['content', memory.content, .82],
      ...(latest === undefined ? [] : [['latestEvidence', latest.excerpt, .18] as const]),
    ])
  })
}

export function compactTurns(turns: ConversationTurn[], charBudget: number): Array<Record<string, unknown>> {
  // A small per-turn floor keeps both speakers represented. The budget only grows
  // beyond its target on exceptionally dense days where dropping a turn would be
  // a larger semantic regression than retaining a minimal index of it.
  const minimumTurnBudget = 48
  const completeTurnBudget = Math.max(charBudget, turns.length * minimumTurnBudget + turns.length + 1)
  return fitEntries(turns, completeTurnBudget, (turn, entryBudget) => {
    const base: Record<string, unknown> = { at: turn.at }
    if (turn.concernDirective !== undefined) base.concernDirective = {
      action: turn.concernDirective.action,
      subject: clip(turn.concernDirective.subject, 100),
    }
    return fitTextFields(base, entryBudget, [['user', turn.user, .64], ['assistant', turn.assistant, .36]])
  }, minimumTurnBudget)
}

function compactTurn(turn: ConversationTurn, userLimit: number, assistantLimit: number): Record<string, unknown> {
  return {
    id: turn.id,
    at: turn.at,
    user: clip(turn.user, userLimit),
    assistant: clip(turn.assistant, assistantLimit),
    ...(turn.concernDirective === undefined ? {} : { concernDirective: turn.concernDirective }),
  }
}

function compactReflection(reflection: DailyReflection): Record<string, unknown> {
  return {
    date: reflection.date,
    summary: clip(reflection.summary, 800),
    events: compactStrings(reflection.events, 12, 100),
    openTasks: compactStrings(reflection.openTasks, 20, 100),
    completedTasks: compactStrings(reflection.completedTasks, 12, 100),
    learnings: compactStrings(reflection.learnings, 12, 100),
    turnCount: reflection.turnCount,
  }
}

function compactConcerns(concerns: PartnerConcern[], limit: number, charBudget: number): Array<Record<string, unknown>> {
  return fitEntries(concerns.slice(0, limit), charBudget, (concern, entryBudget) => fitTextFields({
    id: concern.id,
    origin: concern.origin,
    state: concern.state,
    priority: precision(concern.priority),
    watchKind: concern.watchKind,
  }, entryBudget, [['subject', concern.subject, .34], ['reason', concern.reason, .42], ['watchQuery', concern.watchQuery, .24]]))
}

function compactRelations(relations: MemoryRelationReviewContext[], limit: number, charBudget: number): Array<Record<string, unknown>> {
  return fitEntries(relations.slice(0, limit), charBudget, (relation, entryBudget) => fitTextFields({
    id: relation.id,
    sourceSubject: clip(relation.sourceSubject, 120),
    sourceKind: relation.sourceKind,
    targetSubject: clip(relation.targetSubject, 120),
    targetKind: relation.targetKind,
    kind: relation.kind,
    confidence: precision(relation.confidence),
  }, entryBudget, [['label', relation.label, 1]]))
}

function fitEntries<T>(
  items: T[],
  charBudget: number,
  project: (item: T, entryBudget: number) => Record<string, unknown>,
  minimumEntryBudget = 180,
): Array<Record<string, unknown>> {
  if (items.length === 0) return []
  const maximumCount = Math.max(1, Math.floor((charBudget - 1) / (minimumEntryBudget + 1)))
  const selected = items.slice(0, maximumCount)
  const entryBudget = Math.max(minimumEntryBudget, Math.floor((charBudget - selected.length - 1) / selected.length))
  return selected.map(item => project(item, entryBudget))
}

function fitTextFields(
  base: Record<string, unknown>,
  entryBudget: number,
  fields: ReadonlyArray<readonly [name: string, value: string, weight: number]>,
): Record<string, unknown> {
  const overhead = JSON.stringify(base).length + fields.reduce((sum, [name]) => sum + name.length + 6, 0)
  const available = Math.max(fields.length * 12, entryBudget - overhead)
  const totalWeight = fields.reduce((sum, field) => sum + field[2], 0) || 1
  const result = { ...base }
  for (const [name, value, weight] of fields) result[name] = clip(value, Math.max(12, Math.floor(available * weight / totalWeight)))
  const excess = JSON.stringify(result).length - entryBudget
  if (excess > 0 && fields.length > 0) {
    const [name] = fields[0]!
    result[name] = clip(String(result[name] ?? ''), Math.max(12, String(result[name] ?? '').length - excess))
  }
  return result
}

function compactStrings(values: string[], limit: number, maxLength: number): string[] {
  return values.slice(0, limit).map(value => clip(value, maxLength)).filter(Boolean)
}

function clip(value: string, maximum: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maximum) return text
  if (maximum < 16) return text.slice(0, maximum)
  const remaining = maximum - 1
  const head = Math.ceil(remaining * .7)
  return `${text.slice(0, head)}…${text.slice(-(remaining - head))}`
}

function precision(value: number): number { return Math.round(value * 1_000) / 1_000 }
