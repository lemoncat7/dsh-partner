import type { DatabaseSync } from 'node:sqlite'
import { emptyCharacterState, normalizeCharacterState, normalizeReflectedCharacterState, type CharacterState } from './domain.js'
export function initializeCharacterState(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS character_states(scope_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS context_renewals(session_id TEXT PRIMARY KEY, day TEXT NOT NULL, at INTEGER NOT NULL, removed INTEGER NOT NULL);`)
}
export function readCharacterState(db: DatabaseSync, scope: string): CharacterState {
  const row = db.prepare('SELECT state_json FROM character_states WHERE scope_id=?').get(scope)
  return row ? JSON.parse(String(row.state_json)) as CharacterState : emptyCharacterState()
}
export function saveCharacterState(db: DatabaseSync, scope: string, value: unknown, expectedAt: number): CharacterState {
  const previous = readCharacterState(db, scope)
  if (previous.updatedAt !== expectedAt) throw new Error('角色记忆已更新，请刷新后再保存')
  const state = { ...normalizeCharacterState(value), updatedAt: Math.max(Date.now(), previous.updatedAt + 1) }
  db.prepare('INSERT INTO character_states VALUES (?,?) ON CONFLICT(scope_id) DO UPDATE SET state_json=excluded.state_json').run(scope, JSON.stringify(state))
  return state
}
/** Automatic updates cannot overwrite user pins or newer manual edits. */
export function applyCharacterState(db: DatabaseSync, scope: string, value: unknown, at: number, sourceTurnId: string): void {
  const previous = readCharacterState(db, scope)
  if (previous.updatedAt > at || previous.sourceTurnId === sourceTurnId) return
  const next = normalizeReflectedCharacterState(value)
  const state: CharacterState = { ...next, pins: previous.pins, updatedAt: at, sourceTurnId }
  db.prepare('INSERT INTO character_states VALUES (?,?) ON CONFLICT(scope_id) DO UPDATE SET state_json=excluded.state_json').run(scope, JSON.stringify(state))
}
