import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
import type { PartnerInbox, PartnerNotice } from './domain.js'

/** A bounded inbox, not another copy of conversation or task history. */
export class PartnerInboxStore {
  private revision = Date.now()
  get etag(): string { return `"partner-inbox-${this.revision}"` }
  private shards = new Map<string, DatabaseSync>()
  private closed = false
  releaseOwner(id:string):void {this.shards.get(id)?.close();this.shards.delete(id)}
  private constructor(private readonly db: DatabaseSync, private readonly privateRoot?: (id: string) => string) {}
  static async openPartitioned(path: string, privateRoot: (id: string) => string): Promise<PartnerInboxStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY)')
    db.exec('CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, read_at INTEGER, payload TEXT NOT NULL)')
    await chmod(path, 0o600)
    return new PartnerInboxStore(db, privateRoot)
  }
  private database(owner: string): DatabaseSync {
    if (this.closed) throw new Error('伙伴消息存储已关闭')
    if (!this.privateRoot) return this.db
    const cached = this.shards.get(owner); if (cached) return cached
    const path = join(this.privateRoot(owner), 'inbox.sqlite')
    mkdirSync(dirname(path), {recursive:true,mode:0o700})
    const db = new DatabaseSync(path); chmodSync(path,0o600)
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, read_at INTEGER, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS notices_time ON notices(created_at DESC);')
    this.db.prepare('INSERT OR IGNORE INTO owners(id) VALUES (?)').run(owner)
    this.shards.set(owner,db); return db
  }
  private databases(): DatabaseSync[] {
    if (this.closed) throw new Error('伙伴消息存储已关闭')
    if(!this.privateRoot)return [this.db]
    return [this.db, ...this.db.prepare('SELECT id FROM owners').all().flatMap(row=>{
      const owner=String(row.id)
      if(!existsSync(join(this.privateRoot!(owner),'inbox.sqlite'))){this.shards.get(owner)?.close();this.shards.delete(owner);this.db.prepare('DELETE FROM owners WHERE id=?').run(owner);return []}
      return [this.database(owner)]
    })]
  }
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
    const db = item.kind === 'system' ? this.db : this.database(item.companionId)
    const result = db.prepare('INSERT OR IGNORE INTO notices(id, created_at, payload) VALUES (?, ?, ?)').run(item.id, item.createdAt, JSON.stringify(payload))
    if (result.changes) this.revision++
    db.prepare('DELETE FROM notices WHERE id NOT IN (SELECT id FROM notices ORDER BY created_at DESC, id DESC LIMIT 200)').run()
  }
  snapshot(): PartnerInbox {
    const rows = this.databases().flatMap(db=>db.prepare('SELECT payload, read_at FROM notices ORDER BY created_at DESC, id DESC LIMIT 200').all())
    const items = rows.map(row => ({ ...JSON.parse(String(row.payload)) as PartnerNotice, ...(row.read_at === null ? {} : { readAt: Number(row.read_at) }) }))
    items.sort((a,b)=>b.createdAt-a.createdAt || b.id.localeCompare(a.id))
    const recent = items.slice(0,200)
    return { items: recent, unread: recent.filter(item => item.readAt === undefined).length }
  }
  markRead(ids: string[], at = Date.now()): void {
    for (const db of this.databases()) {
      const update = db.prepare('UPDATE notices SET read_at = COALESCE(read_at, ?) WHERE id = ?')
      db.exec('BEGIN')
      try { for (const id of ids.slice(0, 200)) update.run(at, id); db.exec('COMMIT'); this.revision++ }
      catch (error) { db.exec('ROLLBACK'); throw error }
    }
  }
  remove(ids: string[]): void {
    if (!ids.length) return
    for (const db of this.databases()) {
      const remove = db.prepare('DELETE FROM notices WHERE id = ?')
      for (const id of ids) if (remove.run(id).changes) this.revision++
    }
  }
  close(): void { if(this.closed)return; this.closed=true; for(const db of this.shards.values())db.close(); this.db.close() }
}
