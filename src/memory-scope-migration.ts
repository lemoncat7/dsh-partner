import type { DatabaseSync } from 'node:sqlite'
import {mergePersonaScope} from './persona/migration.js'

/** Caller serializes writes. Preserve IDs, evidence, history and review state. */
export function mergeConversationMemoryScopes(db: DatabaseSync, companionId: string, target: string, sources: string[], recoverLeases = false): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const source of new Set(sources.filter(value => value !== target))) {
      if (!['memories', 'memory_relations', 'memory_jobs', 'daily_reflections', 'memory_scenes', 'memory_experiences', 'persona_state']
        .some(table => db.prepare(`SELECT 1 FROM ${table} WHERE scope_id=? LIMIT 1`).get(source))) continue
      if (recoverLeases) db.prepare('UPDATE memory_jobs SET lease_until=0, lease_token=NULL WHERE scope_id IN (?, ?)').run(source, target)
      // Never move a job while another worker owns its extraction result.
      if (db.prepare('SELECT 1 FROM memory_jobs WHERE scope_id IN (?, ?) AND lease_until>? LIMIT 1').get(source, target, Date.now())) {
        throw new Error('记忆正在整理，稍后重试归并')
      }
      mergePersonaScope(db, source, target)
      for (const table of ['memories', 'memory_relations']) {
        db.prepare(`UPDATE ${table} SET scope_id=? WHERE companion_id=? AND scope_id=?`).run(target, companionId, source)
      }
      for (const table of ['memory_scenes', 'memory_experiences']) {
        db.prepare(`UPDATE ${table} SET scope_id=? WHERE scope_id=?`).run(target, source)
      }
      db.prepare(`UPDATE memory_jobs SET scope_id=?, turn_json=json_set(turn_json, '$.concernScopeId',
        coalesce(json_extract(turn_json, '$.concernScopeId'), scope_id), '$.scopeId', ?) WHERE scope_id=?`).run(target, target, source)
      const days = db.prepare('SELECT * FROM daily_reflections WHERE companion_id=? AND scope_id=?').all(companionId, source)
      for (const day of days) {
        const date = String(day.date)
        const existing = db.prepare('SELECT * FROM daily_reflections WHERE scope_id=? AND date=?').get(target, date)
        if (!existing) {
          db.prepare('UPDATE daily_reflections SET scope_id=? WHERE scope_id=? AND date=?').run(target, source, date)
          continue
        }
        const arrays = ['events_json', 'open_tasks_json', 'completed_tasks_json', 'learnings_json'].map(key =>
          JSON.stringify([...new Set([...JSON.parse(String(existing[key])), ...JSON.parse(String(day[key]))])]))
        const summary = [...new Set([String(existing.summary), String(day.summary)].filter(Boolean))].join('\n\n')
        db.prepare(`UPDATE daily_reflections SET summary=?, events_json=?, open_tasks_json=?, completed_tasks_json=?,
          learnings_json=?, updated_at=?, turn_count=?, reviewed_at=NULL, review_attempts=0, review_error=NULL, next_review_at=0
          WHERE scope_id=? AND date=?`).run(summary, ...arrays, Math.max(Number(existing.updated_at), Number(day.updated_at)),
            Number(existing.turn_count) + Number(day.turn_count), target, date)
        db.prepare('DELETE FROM daily_reflections WHERE scope_id=? AND date=?').run(source, date)
      }
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
