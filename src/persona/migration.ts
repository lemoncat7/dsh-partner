import type {DatabaseSync} from 'node:sqlite'
import type {PersonaCorrection} from './types.js'

/** Part of the caller's scope migration transaction; corrections must never be lost. */
export function mergePersonaScope(db: DatabaseSync, source: string, target: string): void {
  const old = db.prepare('SELECT * FROM persona_state WHERE scope_id=?').get(source)
  if (!old) return
  const current = db.prepare('SELECT * FROM persona_state WHERE scope_id=?').get(target)
  if (!current) {
    db.prepare('UPDATE persona_state SET scope_id=?,lease_token=NULL,lease_until=0,requested=1,next_at=0 WHERE scope_id=?').run(target,source)
  } else {
    const corrections = [...JSON.parse(String(current.corrections)), ...JSON.parse(String(old.corrections))] as PersonaCorrection[]
    const merged = [...new Map(corrections.map(item => [item.id,item])).values()]
    db.prepare('UPDATE persona_state SET corrections=?,lease_token=NULL,lease_until=0,requested=1,next_at=0,revision=revision+1 WHERE scope_id=?')
      .run(JSON.stringify(merged),target)
    if (Number(old.updated_at)>0) db.prepare('INSERT INTO persona_versions(scope_id,payload,updated_at) VALUES (?,?,?)').run(target,String(old.payload),Number(old.updated_at))
    db.prepare('DELETE FROM persona_state WHERE scope_id=?').run(source)
  }
  db.prepare('UPDATE persona_versions SET scope_id=? WHERE scope_id=?').run(target,source)
  db.prepare('DELETE FROM persona_versions WHERE scope_id=? AND id NOT IN (SELECT id FROM persona_versions WHERE scope_id=? ORDER BY updated_at DESC,id DESC LIMIT 5)').run(target,target)
}
