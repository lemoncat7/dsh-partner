import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConversationTurn, PartnerMemory } from './memory-domain.js'

export interface SceneProposal { title: string; memoryIds: string[] }
export interface SceneView extends SceneProposal { id: string; scopeId: string; updatedAt: number; summary: string }
export interface ExperienceProposal { title: string; steps: string[]; evidence: Array<{ turnId: string; quote: string }> }
export interface ExperienceDraft extends ExperienceProposal {
  id: string; scopeId: string; status: 'draft' | 'approved' | 'rejected'; updatedAt: number; version: string
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24)
const canonical = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim()
const text = (value: unknown, limit: number): string => typeof value === 'string' ? canonical(value).slice(0, limit) : ''
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

export function parseArtifactProposals(value: Record<string, unknown>): { scenes: SceneProposal[]; experiences: ExperienceProposal[] } {
  const scenes = (Array.isArray(value.scenes) ? value.scenes : []).slice(0, 8).flatMap(raw => {
    const item = object(raw); const title = text(item.title, 120)
    const memoryIds = [...new Set((Array.isArray(item.memoryIds) ? item.memoryIds : []).map(id => text(id, 160)).filter(Boolean))].slice(0, 12)
    return title && memoryIds.length ? [{ title, memoryIds }] : []
  })
  const experiences = (Array.isArray(value.experiences) ? value.experiences : []).slice(0, 3).flatMap(raw => {
    const item = object(raw); const title = text(item.title, 120)
    const steps = (Array.isArray(item.steps) ? item.steps : []).map(step => text(step, 400)).filter(Boolean).slice(0, 8)
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).slice(0, 8).map(rawEvidence => {
      const source = object(rawEvidence)
      return { turnId: text(source.turnId, 160), quote: text(source.quote, 300) }
    }).filter(source => source.turnId && source.quote)
    return title && steps.length && evidence.length ? [{ title, steps, evidence }] : []
  })
  return { scenes, experiences }
}

/** Repetition alone is not success. Require explicit positive user evidence in
 * at least two distinct sessions; the procedure still requires human review. */
export function groundExperiences(items: ExperienceProposal[], turns: ConversationTurn[]): ExperienceProposal[] {
  const byId = new Map(turns.map(turn => [turn.id, turn]))
  return items.filter(item => {
    const sessions = new Set<string>()
    for (const evidence of item.evidence) {
      const turn = byId.get(evidence.turnId)
      if (!turn || !canonical(turn.user).includes(canonical(evidence.quote))) return false
      const speech = canonical(turn.user); const offset = speech.indexOf(canonical(evidence.quote))
      const surrounding = speech.slice(Math.max(0, offset - 12), offset + evidence.quote.length + 24)
      if (/(?:没|未|不|失败|还需|但是|不过|然而)/u.test(surrounding)) continue
      if (/(?:已(?:经)?解决|测试通过|验收通过|验证通过|运行正常|确实可用|成功了|works correctly|tests passed)/iu.test(evidence.quote)) sessions.add(turn.sessionId)
    }
    return sessions.size >= 2
  })
}

export function initializeMemoryArtifacts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_scenes (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, title TEXT NOT NULL, memory_ids TEXT NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS memory_scenes_scope ON memory_scenes(scope_id, updated_at);
  CREATE TABLE IF NOT EXISTS memory_experiences (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
    version TEXT NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS memory_experiences_scope ON memory_experiences(scope_id, updated_at);`)
}

export function applyMemoryArtifacts(db: DatabaseSync, scopeId: string, memories: PartnerMemory[], scenes: SceneProposal[], experiences: ExperienceProposal[], now: number): void {
  const valid = new Set(memories.filter(item => item.scopeId === scopeId && item.status === 'active'
    && (item.expiresAt === undefined || item.expiresAt > now)).map(item => item.id))
  for (const scene of scenes.slice(0, 8)) {
    if (!scene.memoryIds.every(id => valid.has(id))) continue
    const id = `scene-${digest(`${scopeId}\0${canonical(scene.title)}`)}`
    if (!db.prepare('SELECT 1 FROM memory_scenes WHERE id=?').get(id)
      && Number(db.prepare('SELECT count(*) AS n FROM memory_scenes WHERE scope_id=?').get(scopeId)?.n) >= 100) continue
    db.prepare(`INSERT INTO memory_scenes VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      memory_ids=excluded.memory_ids, updated_at=excluded.updated_at`).run(id, scopeId, scene.title, JSON.stringify(scene.memoryIds), now)
  }
  for (const item of experiences.slice(0, 3)) {
    const id = `experience-${digest(`${scopeId}\0${canonical(item.title)}`)}`
    const payload = JSON.stringify(item); const version = digest(payload)
    const existing = db.prepare('SELECT status, version FROM memory_experiences WHERE id=?').get(id)
    if (!existing && Number(db.prepare('SELECT count(*) AS n FROM memory_experiences WHERE scope_id=?').get(scopeId)?.n) >= 100) continue
    // Rejected/approved drafts are immutable. Evolving an installed skill is a
    // separate explicit action, never an automatic write-back.
    if (existing && (existing.status !== 'draft' || existing.version === version)) continue
    db.prepare(`INSERT INTO memory_experiences VALUES (?, ?, ?, 'draft', ?, ?) ON CONFLICT(id)
      DO UPDATE SET payload=excluded.payload, version=excluded.version, updated_at=excluded.updated_at`).run(id, scopeId, payload, version, now)
  }
}

export function readScenes(db: DatabaseSync, scopeId: string, memories: PartnerMemory[], now = Date.now()): SceneView[] {
  const byId = new Map(memories.filter(item => item.scopeId === scopeId && item.status === 'active'
    && (item.expiresAt === undefined || item.expiresAt > now)).map(item => [item.id, item]))
  return db.prepare('SELECT * FROM memory_scenes WHERE scope_id=? ORDER BY updated_at DESC LIMIT 30').all(scopeId).flatMap(row => {
    const ids = JSON.parse(String(row.memory_ids)) as string[]
    const sources = ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
    if (!sources.length) return []
    // A derived view, not another fact store: deletion/correction takes effect immediately.
    return [{ id: String(row.id), scopeId, title: String(row.title), memoryIds: sources.map(item => item.id),
      updatedAt: Math.max(Number(row.updated_at), ...sources.map(item => item.updatedAt)),
      summary: sources.map(item => `${item.subject}：${item.content}`).join('\n').slice(0, 2400) }]
  })
}

export function readExperienceDrafts(db: DatabaseSync, scopeId: string): ExperienceDraft[] {
  return db.prepare('SELECT * FROM memory_experiences WHERE scope_id=? ORDER BY updated_at DESC LIMIT 30').all(scopeId).map(row => ({
    ...JSON.parse(String(row.payload)) as ExperienceProposal, id: String(row.id), scopeId,
    status: String(row.status) as ExperienceDraft['status'], updatedAt: Number(row.updated_at), version: String(row.version),
  }))
}

export function readExperienceDraft(db: DatabaseSync, scopeId: string, id: string): ExperienceDraft | undefined {
  const row = db.prepare('SELECT * FROM memory_experiences WHERE scope_id=? AND id=?').get(scopeId, id)
  return row ? { ...JSON.parse(String(row.payload)) as ExperienceProposal, id, scopeId,
    status: String(row.status) as ExperienceDraft['status'], updatedAt: Number(row.updated_at), version: String(row.version) } : undefined
}

export function reviewExperienceDraft(db: DatabaseSync, scopeId: string, id: string, version: string, action: 'approved' | 'rejected'): void {
  const result = db.prepare("UPDATE memory_experiences SET status=? WHERE scope_id=? AND id=? AND version=? AND status='draft'").run(action, scopeId, id, version)
  if (!result.changes) throw new Error('经验草稿已变化或已审核，请重新读取后再操作')
}

export function experienceMarkdown(draft: ExperienceDraft): string {
  return ['---', `name: ${draft.id}`, `description: ${JSON.stringify(draft.title)}`, '---', '',
    `# ${draft.title}`, '', '仅在对应场景适用；不扩大工具权限，不替代用户当前指令。', '',
    ...draft.steps.map((step, index) => `${index + 1}. ${step}`), '',
    '## 验证与边界', '', '执行后验证结果；失败时停止并报告，不将重复调用视为成功。涉及删除、覆盖、发布等操作须遵守当前授权。', '',
    '## 来源', '', ...draft.evidence.map(item => `- ${item.turnId}：${item.quote}`)].join('\n')
}
