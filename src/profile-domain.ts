import { createHash } from 'node:crypto'
import type { PartnerMemory, UserProfileSnapshot } from './memory-domain.js'

export const PROFILE_SUBJECTS = ['基本身份', '工作背景', '长期职责', '常用环境', '长期目标'] as const
export type ProfileSubject = typeof PROFILE_SUBJECTS[number]

const PROFILE_ALIASES = new Map<string, ProfileSubject>([
  ['基本身份', '基本身份'], ['身份', '基本身份'], ['个人身份', '基本身份'], ['称呼', '基本身份'],
  ['工作背景', '工作背景'], ['职业背景', '工作背景'], ['职业', '工作背景'], ['工作', '工作背景'],
  ['长期职责', '长期职责'], ['职责', '长期职责'], ['长期责任', '长期职责'], ['主要职责', '长期职责'],
  ['常用环境', '常用环境'], ['工作环境', '常用环境'], ['开发环境', '常用环境'], ['使用环境', '常用环境'],
  ['长期目标', '长期目标'], ['目标', '长期目标'], ['长期计划', '长期目标'], ['长期方向', '长期目标'],
])

const PROFILE_CONFIDENCE_MIN = .72
const PROFILE_IMPORTANCE_MIN = .55
const PROFILE_ENTRY_LIMIT = 6

export function canonicalProfileSubject(value: string): ProfileSubject | undefined {
  return PROFILE_ALIASES.get(value.normalize('NFKC').replace(/[\s:：/／_-]+/gu, '').trim())
}

export function isProfileBaselineEntry(memory: PartnerMemory): boolean {
  return memory.kind === 'profile' && memory.status === 'active'
    && (memory.locked === true || (memory.confidence >= PROFILE_CONFIDENCE_MIN && memory.importance >= PROFILE_IMPORTANCE_MIN))
}

export function buildProfileSnapshot(companionId: string, scopeId: string, memories: PartnerMemory[]): UserProfileSnapshot {
  const entries: PartnerMemory[] = []
  const subjects = new Set<string>()
  for (const memory of memories.filter(isProfileBaselineEntry).sort(compareProfileEntries)) {
    const subject = canonicalProfileSubject(memory.subject) ?? memory.subject.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
    if (subjects.has(subject)) continue
    subjects.add(subject)
    entries.push(memory)
    if (entries.length >= PROFILE_ENTRY_LIMIT) break
  }
  const version = createHash('sha256').update(entries.map(entry => [
    entry.id, canonicalProfileSubject(entry.subject) ?? entry.subject, entry.content, entry.locked ? 1 : 0,
  ].join('\u0000')).join('\u0001')).digest('hex').slice(0, 12)
  return {
    companionId,
    scopeId,
    version,
    ...(entries[0] ? { updatedAt: Math.max(...entries.map(entry => entry.updatedAt)) } : {}),
    entries,
    evidenceCount: new Set(entries.flatMap(entry => entry.evidence.map(evidence => evidence.turnId))).size,
    lockedCount: entries.filter(entry => entry.locked).length,
  }
}

function compareProfileEntries(left: PartnerMemory, right: PartnerMemory): number {
  if (Boolean(left.locked) !== Boolean(right.locked)) return left.locked ? -1 : 1
  const leftRank = subjectRank(left.subject)
  const rightRank = subjectRank(right.subject)
  return leftRank - rightRank || right.importance - left.importance || right.confidence - left.confidence || right.updatedAt - left.updatedAt
}

function subjectRank(subject: string): number {
  const normalized = canonicalProfileSubject(subject)
  return normalized === undefined ? PROFILE_SUBJECTS.length : PROFILE_SUBJECTS.indexOf(normalized)
}
