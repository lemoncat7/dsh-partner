import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationTurn, DailyReflection, DailyReviewResult, DailyReviewTarget, MemoryCandidate, MemoryEvidence, MemoryKind, MemoryRelation, MemoryRelationKind, MemoryStatus, PartnerMemory } from './memory-domain.js'

interface MemoryDocument { schemaVersion: 1; memories: PartnerMemory[] }
type ReflectionResultLike = { daily: Omit<DailyReflection, 'date' | 'companionId' | 'scopeId' | 'updatedAt' | 'turnCount'>; memories: MemoryCandidate[] }
export interface LegacyHeartbeatFocus { scopeId: string; subject: string; reason: string; confidence: number }
type SqlRow = Record<string, unknown>

export class PartnerMemoryStore {
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly root: string, private readonly timeZone = 'Asia/Shanghai') {}

  day(at: number): string { return localDay(at, this.timeZone) }

  async archive(turn: ConversationTurn): Promise<void> {
    const directory = this.scopeDirectory(turn.companionId, turn.scopeId)
    const path = join(directory, 'conversations', `${localDay(turn.at, this.timeZone)}.jsonl`)
    await this.serial(path, async () => {
      await mkdir(join(directory, 'conversations'), { recursive: true, mode: 0o700 })
      await appendFile(path, `${JSON.stringify(turn)}\n`, { encoding: 'utf8', mode: 0o600 })
    })
  }

  async consolidate(turn: ConversationTurn, result: ReflectionResultLike): Promise<void> {
    await this.serial(this.databasePath(turn.companionId), async () => {
      const database = await this.open(turn.companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        const existing = this.memoriesForScope(database, turn.companionId, turn.scopeId)
        for (const memory of mergeMemories(existing, result.memories, turn)) this.upsertMemory(database, memory)
        const date = localDay(turn.at, this.timeZone)
        const previous = database.prepare('SELECT turn_count FROM daily_reflections WHERE scope_id = ? AND date = ?').get(turn.scopeId, date) as SqlRow | undefined
        database.prepare(`INSERT INTO daily_reflections
          (date, companion_id, scope_id, summary, events_json, open_tasks_json, completed_tasks_json, learnings_json, updated_at, turn_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_id, date) DO UPDATE SET summary=excluded.summary, events_json=excluded.events_json,
          open_tasks_json=excluded.open_tasks_json, completed_tasks_json=excluded.completed_tasks_json,
          learnings_json=excluded.learnings_json, updated_at=excluded.updated_at, turn_count=excluded.turn_count`).run(
          date, turn.companionId, turn.scopeId, compact(result.daily.summary, 1200), json(strings(result.daily.events, 20, 240)),
          json(strings(result.daily.openTasks, 20, 240)), json(strings(result.daily.completedTasks, 20, 240)),
          json(strings(result.daily.learnings, 20, 240)), Date.now(), number(previous?.turn_count) + 1,
        )
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  async recall(companionId: string, scopeId: string, query: string, limit = 12): Promise<PartnerMemory[]> {
    const database = await this.open(companionId)
    try {
      const now = Date.now()
      const rows = database.prepare(`SELECT * FROM memories
        WHERE scope_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY updated_at DESC`).all(scopeId, now) as SqlRow[]
      const terms = tokenize(query)
      return rows.map(memoryFromRow).map(item => ({ item, score: recallScore(item, terms, now) }))
        .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
        .slice(0, limit).map(entry => entry.item)
    } finally { database.close() }
  }

  async recentMemories(companionId: string, limit = 100): Promise<PartnerMemory[]> {
    const database = await this.open(companionId)
    try { return (database.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as SqlRow[]).map(memoryFromRow) }
    finally { database.close() }
  }

  async legacyHeartbeatFocuses(companionId: string): Promise<LegacyHeartbeatFocus[]> {
    const database = await this.open(companionId)
    try {
      if (!tableExists(database, 'heartbeat_focuses')) return []
      return (database.prepare('SELECT scope_id, topic, reason, confidence FROM heartbeat_focuses WHERE companion_id = ?').all(companionId) as SqlRow[]).map(row => ({
        scopeId: string(row.scope_id), subject: string(row.topic), reason: string(row.reason), confidence: bounded(number(row.confidence)),
      }))
    } finally { database.close() }
  }

  async dropLegacyHeartbeatFocuses(companionId: string): Promise<void> {
    await this.serial(this.databasePath(companionId), async () => {
      const database = await this.open(companionId)
      try { database.exec('DROP TABLE IF EXISTS heartbeat_focus_dismissals; DROP TABLE IF EXISTS heartbeat_focuses;') }
      finally { database.close() }
    })
  }

  async updateMemory(companionId: string, memoryId: string, subject: string, content: string): Promise<PartnerMemory> {
    return this.serialValue(this.databasePath(companionId), async () => {
      const database = await this.open(companionId)
      try {
        const result = database.prepare(`UPDATE memories SET subject = ?, content = ?, updated_at = ?, confidence = 1, locked = 1
          WHERE companion_id = ? AND id = ?`).run(compact(subject, 120), compact(content, 800), Date.now(), companionId, memoryId)
        if (result.changes === 0) throw new Error('memory was not found')
        return memoryFromRow(database.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as SqlRow)
      } finally { database.close() }
    })
  }

  async deleteMemory(companionId: string, memoryId: string): Promise<void> {
    await this.serial(this.databasePath(companionId), async () => {
      const database = await this.open(companionId)
      try {
        const result = database.prepare('DELETE FROM memories WHERE companion_id = ? AND id = ?').run(companionId, memoryId)
        if (result.changes === 0) throw new Error('memory was not found')
      } finally { database.close() }
    })
  }

  async recentReflections(companionId: string, limit = 30): Promise<DailyReflection[]> {
    const database = await this.open(companionId)
    try { return (database.prepare('SELECT * FROM daily_reflections ORDER BY updated_at DESC LIMIT ?').all(limit) as SqlRow[]).map(reflectionFromRow) }
    finally { database.close() }
  }

  async recentReflectionsForScope(companionId: string, scopeId: string, limit = 30): Promise<DailyReflection[]> {
    const database = await this.open(companionId)
    try { return (database.prepare('SELECT * FROM daily_reflections WHERE scope_id = ? ORDER BY date DESC LIMIT ?').all(scopeId, limit) as SqlRow[]).map(reflectionFromRow) }
    finally { database.close() }
  }

  async pendingDailyReviews(companionId: string, date: string, now = Date.now()): Promise<DailyReviewTarget[]> {
    const database = await this.open(companionId)
    try {
      return (database.prepare(`SELECT companion_id, scope_id, date, review_attempts FROM daily_reflections
        WHERE companion_id = ? AND date <= ? AND reviewed_at IS NULL AND next_review_at <= ?
        ORDER BY date, updated_at LIMIT 20`).all(companionId, date, now) as SqlRow[]).map(row => ({
        companionId: string(row.companion_id), scopeId: string(row.scope_id), date: string(row.date), attempts: number(row.review_attempts),
      }))
    } finally { database.close() }
  }

  async dailyReviewContext(target: DailyReviewTarget): Promise<{ reflection: DailyReflection; memories: PartnerMemory[]; turns: ConversationTurn[] }> {
    const database = await this.open(target.companionId)
    let reflection: DailyReflection
    let memories: PartnerMemory[]
    try {
      const row = database.prepare('SELECT * FROM daily_reflections WHERE scope_id = ? AND date = ?').get(target.scopeId, target.date) as SqlRow | undefined
      if (!row) throw new Error('daily reflection was not found')
      reflection = reflectionFromRow(row)
      memories = this.memoriesForScope(database, target.companionId, target.scopeId).filter(item => item.status === 'active')
    } finally { database.close() }
    const path = join(this.scopeDirectory(target.companionId, target.scopeId), 'conversations', `${target.date}.jsonl`)
    const turns = (await readFile(path, 'utf8').catch(error => missing(error) ? '' : Promise.reject(error))).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line) as ConversationTurn] } catch { return [] }
    })
    return { reflection, memories, turns }
  }

  async completeDailyReview(target: DailyReviewTarget, result: DailyReviewResult): Promise<void> {
    await this.serial(this.databasePath(target.companionId), async () => {
      const database = await this.open(target.companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        const existing = this.memoriesForScope(database, target.companionId, target.scopeId)
        const at = Date.now()
        const synthetic: ConversationTurn = { id: `daily-review-${target.date}`, companionId: target.companionId, scopeId: target.scopeId, sessionId: 'daily-review', at, user: `每日终审 ${target.date}`, assistant: result.daily.summary }
        const merged = mergeMemories(existing, result.memories, synthetic)
        for (const memory of merged) this.upsertMemory(database, memory)
        database.prepare(`UPDATE daily_reflections SET summary=?, events_json=?, open_tasks_json=?, completed_tasks_json=?,
          learnings_json=?, updated_at=?, reviewed_at=?, review_attempts=0, review_error=NULL, next_review_at=0
          WHERE scope_id=? AND date=?`).run(compact(result.daily.summary, 1200), json(strings(result.daily.events, 20, 240)),
          json(strings(result.daily.openTasks, 20, 240)), json(strings(result.daily.completedTasks, 20, 240)),
          json(strings(result.daily.learnings, 20, 240)), at, at, target.scopeId, target.date)
        const bySubject = new Map(merged.filter(item => item.status === 'active').map(item => [normalize(item.subject), item]))
        database.prepare('DELETE FROM memory_relations WHERE companion_id=? AND scope_id=?').run(target.companionId, target.scopeId)
        const insert = database.prepare(`INSERT INTO memory_relations
          (id, companion_id, scope_id, source_memory_id, target_memory_id, kind, label, confidence, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const relation of result.relations.slice(0, 80)) {
          const source = bySubject.get(normalize(relation.sourceSubject)); const destination = bySubject.get(normalize(relation.targetSubject))
          if (!source || !destination || source.id === destination.id) continue
          insert.run(`relation-${randomUUID()}`, target.companionId, target.scopeId, source.id, destination.id,
            relation.kind, compact(relation.label, 120), bounded(relation.confidence), at)
        }
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  async failDailyReview(target: DailyReviewTarget, error: string): Promise<void> {
    const database = await this.open(target.companionId)
    try {
      const attempts = target.attempts + 1
      database.prepare(`UPDATE daily_reflections SET review_attempts=?, review_error=?, next_review_at=? WHERE scope_id=? AND date=?`).run(
        attempts, compact(error, 500), Date.now() + Math.min(21_600_000, 60_000 * 2 ** Math.min(attempts, 8)), target.scopeId, target.date)
    } finally { database.close() }
  }

  async relations(companionId: string, limit = 500): Promise<{ memories: PartnerMemory[]; relations: MemoryRelation[] }> {
    const database = await this.open(companionId)
    try {
      const relations = (database.prepare('SELECT * FROM memory_relations WHERE companion_id=? ORDER BY confidence DESC, updated_at DESC LIMIT ?').all(companionId, limit) as SqlRow[]).map(relationFromRow)
      const ids = [...new Set(relations.flatMap(item => [item.sourceMemoryId, item.targetMemoryId]))]
      const memories = ids.length === 0 ? [] : (database.prepare(`SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as SqlRow[]).map(memoryFromRow)
      return { memories, relations }
    } finally { database.close() }
  }

  async clear(companionId: string): Promise<void> {
    await rm(this.memoryRoot(companionId), { recursive: true, force: true })
  }

  async migrateLegacy(companionId: string): Promise<number> {
    const journalCount = await this.migrateJournal(companionId)
    const jsonCount = await this.migrateJson(companionId)
    return journalCount + jsonCount
  }

  async prune(companionId: string, retentionDays: number): Promise<void> {
    if (retentionDays === 0) return
    const cutoff = Date.now() - retentionDays * 86_400_000
    const scopes = await this.scopeDirectories(companionId)
    await Promise.all(scopes.map(directory => this.serial(directory, async () => {
      const target = join(directory, 'conversations')
      const files = await readdir(target).catch(error => missing(error) ? [] : Promise.reject(error))
      await Promise.all(files.filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && Date.parse(file.slice(0, 10)) < cutoff).map(file => rm(join(target, file), { force: true })))
    })))
    await this.serial(this.databasePath(companionId), async () => {
      const database = await this.open(companionId)
      try {
        database.exec('BEGIN IMMEDIATE')
        database.prepare('DELETE FROM daily_reflections WHERE companion_id = ? AND updated_at < ?').run(companionId, cutoff)
        database.prepare('DELETE FROM memories WHERE companion_id = ? AND updated_at < ?').run(companionId, cutoff)
        database.exec('COMMIT')
      } catch (error) { rollback(database); throw error } finally { database.close() }
    })
  }

  private async open(companionId: string): Promise<DatabaseSync> {
    await mkdir(this.memoryRoot(companionId), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(this.databasePath(companionId))
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
        subject TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL,
        importance REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER, locked INTEGER NOT NULL DEFAULT 0, evidence_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope_status_updated ON memories(scope_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_companion_kind_updated ON memories(companion_id, kind, updated_at DESC);
      CREATE TABLE IF NOT EXISTS daily_reflections (
        date TEXT NOT NULL, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL, summary TEXT NOT NULL,
        events_json TEXT NOT NULL, open_tasks_json TEXT NOT NULL, completed_tasks_json TEXT NOT NULL,
        learnings_json TEXT NOT NULL, updated_at INTEGER NOT NULL, turn_count INTEGER NOT NULL,
        PRIMARY KEY(scope_id, date)
      );
      CREATE INDEX IF NOT EXISTS reflections_companion_updated ON daily_reflections(companion_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, scope_id TEXT NOT NULL, source_memory_id TEXT NOT NULL,
        target_memory_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, confidence REAL NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY(source_memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY(target_memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS relations_companion_scope ON memory_relations(companion_id, scope_id, updated_at DESC);
      PRAGMA user_version = 1;`)
    ensureColumn(database, 'daily_reflections', 'reviewed_at', 'INTEGER')
    ensureColumn(database, 'daily_reflections', 'review_attempts', 'INTEGER NOT NULL DEFAULT 0')
    ensureColumn(database, 'daily_reflections', 'review_error', 'TEXT')
    ensureColumn(database, 'daily_reflections', 'next_review_at', 'INTEGER NOT NULL DEFAULT 0')
    return database
  }

  private memoriesForScope(database: DatabaseSync, companionId: string, scopeId: string): PartnerMemory[] {
    return (database.prepare('SELECT * FROM memories WHERE companion_id = ? AND scope_id = ?').all(companionId, scopeId) as SqlRow[]).map(memoryFromRow)
  }

  private upsertMemory(database: DatabaseSync, memory: PartnerMemory): void {
    database.prepare(`INSERT INTO memories
      (id, companion_id, scope_id, kind, subject, content, status, confidence, importance, created_at, updated_at, expires_at, locked, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, subject=excluded.subject, content=excluded.content,
      status=excluded.status, confidence=excluded.confidence, importance=excluded.importance, updated_at=excluded.updated_at,
      expires_at=excluded.expires_at, locked=excluded.locked, evidence_json=excluded.evidence_json`).run(
      memory.id, memory.companionId, memory.scopeId, memory.kind, memory.subject, memory.content, memory.status,
      memory.confidence, memory.importance, memory.createdAt, memory.updatedAt, memory.expiresAt ?? null,
      memory.locked ? 1 : 0, json(memory.evidence),
    )
  }

  private async migrateJson(companionId: string): Promise<number> {
    const scopes = await this.scopeDirectories(companionId)
    if (scopes.length === 0) return 0
    const database = await this.open(companionId)
    const migratedFiles: Array<{ source: string; target: string }> = []
    let migrated = 0
    try {
      database.exec('BEGIN IMMEDIATE')
      for (const directory of scopes) {
        const scopeHash = directory.split('/').at(-1) ?? 'unknown'
        const documentPath = join(directory, 'memories.json')
        const document = await readJson<MemoryDocument>(documentPath)
        if (document) {
          for (const memory of document.memories) { this.upsertMemory(database, memory); migrated += 1 }
          migratedFiles.push({ source: documentPath, target: join(this.memoryRoot(companionId), 'legacy-json', scopeHash, 'memories.json') })
        }
        const diaryDirectory = join(directory, 'diary')
        const files = await readdir(diaryDirectory).catch(error => missing(error) ? [] : Promise.reject(error))
        for (const file of files.filter(item => /^\d{4}-\d{2}-\d{2}\.json$/.test(item))) {
          const source = join(diaryDirectory, file)
          const reflection = await readJson<DailyReflection>(source)
          if (!reflection) continue
          this.upsertReflection(database, reflection)
          migrated += 1
          migratedFiles.push({ source, target: join(this.memoryRoot(companionId), 'legacy-json', scopeHash, 'diary', file) })
        }
      }
      database.exec('COMMIT')
    } catch (error) { rollback(database); throw error } finally { database.close() }
    for (const file of migratedFiles) await archiveMigratedFile(file.source, file.target)
    return migrated
  }

  private upsertReflection(database: DatabaseSync, reflection: DailyReflection): void {
    database.prepare(`INSERT INTO daily_reflections
      (date, companion_id, scope_id, summary, events_json, open_tasks_json, completed_tasks_json, learnings_json, updated_at, turn_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, date) DO UPDATE SET summary=excluded.summary, events_json=excluded.events_json,
      open_tasks_json=excluded.open_tasks_json, completed_tasks_json=excluded.completed_tasks_json,
      learnings_json=excluded.learnings_json, updated_at=excluded.updated_at, turn_count=excluded.turn_count`).run(
      reflection.date, reflection.companionId, reflection.scopeId, reflection.summary, json(reflection.events),
      json(reflection.openTasks), json(reflection.completedTasks), json(reflection.learnings), reflection.updatedAt, reflection.turnCount,
    )
  }

  private async migrateJournal(companionId: string): Promise<number> {
    const legacy = join(this.memoryRoot(companionId), 'journal')
    const scopes = await readdir(legacy, { withFileTypes: true }).catch(error => missing(error) ? [] : Promise.reject(error))
    let migrated = 0
    for (const scope of scopes.filter(item => item.isDirectory())) {
      const directory = join(legacy, scope.name)
      const files = await readdir(directory).catch(() => [])
      for (const file of files.filter(item => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item))) {
        const lines = (await readFile(join(directory, file), 'utf8')).split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const item = JSON.parse(line) as { id?: string; scopeId?: string; at?: number; summary?: string; outcome?: string }
            if (!item.scopeId || !item.at || !item.summary || !item.outcome) continue
            await this.archive({ id: item.id ?? `legacy-${randomUUID()}`, companionId, scopeId: item.scopeId, sessionId: 'legacy-journal', at: item.at, user: item.summary, assistant: item.outcome })
            migrated += 1
          } catch { /* Preserve invalid legacy lines for manual recovery. */ }
        }
      }
    }
    if (migrated > 0) await rename(legacy, join(this.memoryRoot(companionId), 'legacy-journal'))
    return migrated
  }

  private async scopeDirectories(companionId: string): Promise<string[]> {
    const root = join(this.memoryRoot(companionId), 'scopes')
    const entries = await readdir(root, { withFileTypes: true }).catch(error => missing(error) ? [] : Promise.reject(error))
    return entries.filter(item => item.isDirectory()).map(item => join(root, item.name))
  }

  private memoryRoot(companionId: string): string { return join(this.root, 'partners', companionId, 'memory') }
  private databasePath(companionId: string): string { return join(this.memoryRoot(companionId), 'memory.sqlite') }
  private scopeDirectory(companionId: string, scopeId: string): string { return join(this.memoryRoot(companionId), 'scopes', createHash('sha256').update(scopeId).digest('hex').slice(0, 24)) }

  private async serial(key: string, task: () => Promise<void>): Promise<void> { await this.serialValue(key, task) }
  private async serialValue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve()
    let value!: T
    const current = previous.catch(() => {}).then(async () => { value = await task() })
    this.writes.set(key, current)
    try { await current; return value } finally { if (this.writes.get(key) === current) this.writes.delete(key) }
  }
}

function mergeMemories(existing: PartnerMemory[], candidates: MemoryCandidate[], turn: ConversationTurn): PartnerMemory[] {
  const memories = existing.map(item => ({ ...item, evidence: [...item.evidence] }))
  for (const candidate of candidates.slice(0, 12)) {
    const match = memories.find(item => item.kind === candidate.kind && normalize(item.subject) === normalize(candidate.subject) && item.status !== 'superseded')
    if (candidate.operation === 'remove') { if (match) { match.status = 'superseded'; match.updatedAt = turn.at }; continue }
    if (candidate.operation === 'complete') { if (match) { match.status = 'completed'; match.updatedAt = turn.at }; continue }
    const evidence = { turnId: turn.id, at: turn.at, excerpt: compact(turn.user, 300) }
    if (match) {
      if (!match.locked) match.content = compact(candidate.content, 800)
      match.confidence = Math.max(match.confidence, bounded(candidate.confidence)); match.importance = Math.max(match.importance, bounded(candidate.importance))
      match.updatedAt = turn.at; match.status = 'active'; match.evidence = [...match.evidence.filter(item => item.turnId !== turn.id), evidence].slice(-8)
      if (candidate.expiresInDays) match.expiresAt = turn.at + candidate.expiresInDays * 86_400_000
    } else memories.push({
      id: `memory-${randomUUID()}`, companionId: turn.companionId, scopeId: turn.scopeId, kind: candidate.kind,
      subject: compact(candidate.subject, 120), content: compact(candidate.content, 800), status: 'active',
      confidence: bounded(candidate.confidence), importance: bounded(candidate.importance), createdAt: turn.at, updatedAt: turn.at,
      ...(candidate.expiresInDays ? { expiresAt: turn.at + candidate.expiresInDays * 86_400_000 } : {}), evidence: [evidence],
    })
  }
  return memories
}

function memoryFromRow(row: SqlRow): PartnerMemory {
  return {
    id: string(row.id), companionId: string(row.companion_id), scopeId: string(row.scope_id), kind: string(row.kind) as MemoryKind,
    subject: string(row.subject), content: string(row.content), status: string(row.status) as MemoryStatus,
    confidence: number(row.confidence), importance: number(row.importance), createdAt: number(row.created_at), updatedAt: number(row.updated_at),
    ...(row.expires_at === null ? {} : { expiresAt: number(row.expires_at) }), ...(number(row.locked) === 1 ? { locked: true } : {}),
    evidence: parseJson<MemoryEvidence[]>(row.evidence_json, []),
  }
}

function reflectionFromRow(row: SqlRow): DailyReflection {
  return {
    date: string(row.date), companionId: string(row.companion_id), scopeId: string(row.scope_id), summary: string(row.summary),
    events: parseJson<string[]>(row.events_json, []), openTasks: parseJson<string[]>(row.open_tasks_json, []),
    completedTasks: parseJson<string[]>(row.completed_tasks_json, []), learnings: parseJson<string[]>(row.learnings_json, []),
    updatedAt: number(row.updated_at), turnCount: number(row.turn_count),
  }
}

function relationFromRow(row: SqlRow): MemoryRelation {
  return {
    id: string(row.id), companionId: string(row.companion_id), scopeId: string(row.scope_id),
    sourceMemoryId: string(row.source_memory_id), targetMemoryId: string(row.target_memory_id),
    kind: string(row.kind) as MemoryRelationKind, label: string(row.label), confidence: number(row.confidence), updatedAt: number(row.updated_at),
  }
}

function recallScore(memory: PartnerMemory, terms: string[], now: number): number {
  const haystack = normalize(`${memory.subject} ${memory.content}`)
  const lexical = terms.length === 0 ? 0 : terms.filter(term => haystack.includes(term)).length / terms.length
  const recency = Math.max(0, 1 - (now - memory.updatedAt) / (180 * 86_400_000))
  return lexical * 0.5 + memory.importance * 0.22 + memory.confidence * 0.18 + recency * 0.1
}

function rollback(database: DatabaseSync): void { try { database.exec('ROLLBACK') } catch { /* No active transaction. */ } }
function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
}
function tokenize(value: string): string[] { return [...new Set(normalize(value).match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 40) }
function normalize(value: string): string { return value.toLocaleLowerCase().replace(/\s+/g, '') }
function bounded(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5 }
function strings(value: string[], limit: number, max: number): string[] { return [...new Set(value.map(item => compact(item, max)).filter(Boolean))].slice(0, limit) }
function compact(value: string, max: number): string { const text = value.replace(/\s+/g, ' ').trim(); return text.length <= max ? text : `${text.slice(0, max - 1)}…` }
function string(value: unknown): string { return typeof value === 'string' ? value : String(value ?? '') }
function number(value: unknown): number { return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value ?? 0) }
function json(value: unknown): string { return JSON.stringify(value) }
function parseJson<T>(value: unknown, fallback: T): T { try { return JSON.parse(string(value)) as T } catch { return fallback } }
export function localMemoryDay(value: number, timeZone = 'Asia/Shanghai'): string { return localDay(value, timeZone) }
function localDay(value: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
async function readJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if (missing(error)) return undefined; throw error } }
async function archiveMigratedFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await rename(source, target) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await rm(source, { force: true }) }
}
