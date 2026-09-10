import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConversationTurn, ReflectionResult } from './memory-domain.js'

export interface MemoryJob { turn: ConversationTurn; token: string; attempts: number; result?: ReflectionResult }
const LEASE_MS = 5 * 60_000

/** SQL-only durable journal. Connections and transactions belong to the memory store. */
export function initializeMemoryJournal(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_jobs (
    id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, at INTEGER NOT NULL, turn_json TEXT NOT NULL,
    result_json TEXT, done INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, committed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS memory_jobs_pending ON memory_jobs(done, next_at, at);
  CREATE INDEX IF NOT EXISTS memory_jobs_scope ON memory_jobs(scope_id, at);`)
}

export function enqueueMemoryJob(db: DatabaseSync, turn: ConversationTurn): void {
  db.prepare('INSERT OR IGNORE INTO memory_jobs (id, scope_id, at, turn_json) VALUES (?, ?, ?, ?)')
    .run(turn.id, turn.scopeId, turn.at, JSON.stringify(turn))
}

export function claimMemoryJob(db: DatabaseSync, now: number): MemoryJob | undefined {
  // Preserve ordering for transient errors; repeatedly failing jobs yield while
  // backing off. They remain durable and become eligible at their retry time.
  const token = randomUUID()
  const row = db.prepare(`UPDATE memory_jobs SET lease_token=?, lease_until=? WHERE id=(
    SELECT j.id FROM memory_jobs j WHERE j.done=0 AND j.next_at<=? AND j.lease_until<=?
    AND NOT EXISTS (SELECT 1 FROM memory_jobs WHERE done=0 AND lease_until>?)
    AND NOT EXISTS (SELECT 1 FROM memory_jobs p WHERE p.scope_id=j.scope_id AND p.done=0 AND (p.attempts<3 OR p.next_at<=?)
      AND (p.at<j.at OR (p.at=j.at AND p.rowid<j.rowid)))
    ORDER BY j.at, j.rowid LIMIT 1
  ) RETURNING turn_json, result_json, attempts`).get(token, now + LEASE_MS, now, now, now, now)
  if (!row) return undefined
  return { turn: JSON.parse(String(row.turn_json)), token, attempts: Number(row.attempts),
    ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}) }
}

export function checkpointMemoryJob(db: DatabaseSync, job: MemoryJob, result: ReflectionResult): void {
  const changed = db.prepare('UPDATE memory_jobs SET result_json=? WHERE id=? AND lease_token=? AND done=0')
    .run(JSON.stringify(result), job.turn.id, job.token)
  if (!changed.changes) throw new Error('memory job lease was lost')
}

export function settleMemoryJob(db: DatabaseSync, job: MemoryJob, error?: string, now = Date.now()): void {
  const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(job.attempts, 7))
  db.prepare(`UPDATE memory_jobs SET done=?, attempts=attempts+?, next_at=?, lease_token=NULL,
    lease_until=0, last_error=? WHERE id=? AND lease_token=?`)
    .run(error === undefined ? 1 : 0, error === undefined ? 0 : 1, error === undefined ? 0 : now + delay,
      error?.slice(0, 500) ?? null, job.turn.id, job.token)
}

export function assertMemoryLease(db: DatabaseSync, job: MemoryJob): void {
  if (!db.prepare('SELECT 1 FROM memory_jobs WHERE id=? AND lease_token=? AND done=0').get(job.turn.id, job.token)) {
    throw new Error('memory job lease was lost')
  }
}
