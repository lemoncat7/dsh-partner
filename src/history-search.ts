import type { DatabaseSync } from 'node:sqlite'
import type { ConversationTurn } from './memory-domain.js'
import { memoryTerms } from './memory-retrieval.js'

const words = (text: string) => memoryTerms(text).filter(x => x.length > 1)
function tokens(turn: ConversationTurn): string {
  const parts = `${turn.user}\n${turn.assistant}`.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_]+|\p{Script=Han}+/gu) ?? []
  return [...new Set(parts.flatMap(word => /^\p{Script=Han}+$/u.test(word) && word.length > 2
    ? Array.from({length: word.length - 1}, (_, i) => word.slice(i, i + 2)) : [word]))].join(' ')
}
export function indexHistoryTurn(db: DatabaseSync, turn: ConversationTurn): void {
  if (db.prepare('SELECT 1 FROM partner_history_fts WHERE id=? LIMIT 1').get(turn.id)) return
  db.prepare('INSERT INTO partner_history_fts(id,scope_id,terms) VALUES (?,?,?)').run(turn.id, turn.scopeId, tokens(turn))
}
export function initializeHistorySearch(db: DatabaseSync): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS partner_history_fts USING fts5(id UNINDEXED, scope_id UNINDEXED, terms);
    CREATE TRIGGER IF NOT EXISTS partner_history_delete AFTER DELETE ON memory_jobs BEGIN DELETE FROM partner_history_fts WHERE id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS partner_history_scope AFTER UPDATE OF scope_id ON memory_jobs BEGIN UPDATE partner_history_fts SET scope_id=new.scope_id WHERE id=new.id; END;`)
  if (db.prepare("SELECT 1 FROM memory_maintenance WHERE key='history-fts-v1'").get()) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of db.prepare('SELECT turn_json FROM memory_jobs').iterate()) indexHistoryTurn(db, JSON.parse(String(row.turn_json)))
    db.prepare("INSERT INTO memory_maintenance VALUES ('history-fts-v1')").run()
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
export function searchHistory(db: DatabaseSync, scope: string, query: string, limit = 4): Array<Pick<ConversationTurn, 'id' | 'at' | 'user' | 'assistant'>> {
  const terms = words(query).slice(0, 24)
  if (!terms.length) return []
  const match = terms.map(x => `"${x.replaceAll('"', '""')}"`).join(' OR ')
  const rows = db.prepare(`SELECT j.turn_json FROM partner_history_fts f JOIN memory_jobs j ON j.id=f.id
    WHERE partner_history_fts MATCH ? AND j.scope_id=? ORDER BY rank LIMIT ?`).all(match, scope, Math.min(12, Math.max(1, limit)))
  return rows.map(row => {
    const turn = JSON.parse(String(row.turn_json)) as ConversationTurn
    return { id: turn.id, at: turn.at, user: excerpt(turn.user, terms, 1200), assistant: excerpt(turn.assistant, terms, 1200) }
  })
}
function excerpt(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text
  const lower = text.toLocaleLowerCase()
  const offsets = terms.map(t => lower.indexOf(t)).filter(i => i >= 0)
  const start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 160)
  return `${start ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`
}
