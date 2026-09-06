import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PartnerInbox, PartnerNotice } from './domain.js'

/** A bounded inbox, not another copy of conversation or task history. */
export class PartnerInboxStore {
  private revision = Date.now()
  get etag(): string { return `"partner-inbox-${this.revision}"` }
  private constructor(private readonly db: DatabaseSync) {}
  static async open(path: string): Promise<PartnerInboxStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, read_at INTEGER, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS notices_time ON notices(created_at DESC);')
      return new PartnerInboxStore(db)
    } catch (error) { db.close(); throw error }
  }
  append(item: PartnerNotice): void {
    if (!item.id || !item.summary.trim()) return
    const payload: PartnerNotice = { ...item, title: item.title.slice(0, 200), summary: item.summary.slice(0, 2000) }
    delete payload.readAt
    const result = this.db.prepare('INSERT OR IGNORE INTO notices(id, created_at, payload) VALUES (?, ?, ?)').run(item.id, item.createdAt, JSON.stringify(payload))
    if (result.changes) this.revision++
    this.db.prepare('DELETE FROM notices WHERE id NOT IN (SELECT id FROM notices ORDER BY created_at DESC, id DESC LIMIT 200)').run()
  }
  snapshot(): PartnerInbox {
    const rows = this.db.prepare('SELECT payload, read_at FROM notices ORDER BY created_at DESC, id DESC LIMIT 200').all()
    const items = rows.map(row => ({ ...JSON.parse(String(row.payload)) as PartnerNotice, ...(row.read_at === null ? {} : { readAt: Number(row.read_at) }) }))
    return { items, unread: items.filter(item => item.readAt === undefined).length }
  }
  markRead(ids: string[], at = Date.now()): void {
    const update = this.db.prepare('UPDATE notices SET read_at = COALESCE(read_at, ?) WHERE id = ?')
    this.db.exec('BEGIN')
    try { for (const id of ids.slice(0, 200)) update.run(at, id); this.db.exec('COMMIT'); this.revision++ }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }
}
