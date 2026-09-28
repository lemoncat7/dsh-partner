import { createHash } from 'node:crypto'
import { constants, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { chmod, mkdir, open, realpath, readFile, writeFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractOutboundAttachments } from '../channels/outbound-media.js'
import { PARTNER_MEDIA_MAX_BYTES, type PartnerOutboundAttachment } from '../channel-message.js'
import { attachmentOwnerDirectory, groupAttachmentFiles } from './grouped-storage.js'

export interface AttachmentDelivery {
  id: string; companionId: string; sessionId: string; name: string; mediaType: string
  kind: 'image' | 'file'; size: number; hash: string; channel: 'pending' | 'sent' | 'failed' | 'none'
  channelRouteId?: string
  createdAt?: number
}
const DEFAULT_LIMIT_MIB = 512

/** Explicit immutable deliveries, separate from mutable workspace files and board state. */
export class AttachmentDeliveryService {
  private queues = new Map<string, Promise<unknown>>()
  private closed = false
  private shards = new Map<string, DatabaseSync>()
  releaseOwner(id:string):void {this.shards.get(id)?.close();this.shards.delete(id)}
  async removeOwner(id:string):Promise<void>{
    await this.serial('storage',async()=>{
      for(const item of await this.storedEntries())if(item.companionId===id)await this.removeStored(item)
      this.releaseOwner(id)
    })
  }
  private constructor(private readonly root: string, private readonly db: DatabaseSync, private readonly privateRoot?: (id: string) => string, private grouped = false) {
    db.exec('CREATE TABLE IF NOT EXISTS attachment_settings(key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
  }
  get limitMiB(): number {
    const row = this.db.prepare("SELECT value FROM attachment_settings WHERE key='limitMiB'").get()
    return row ? Number(row.value) : DEFAULT_LIMIT_MIB
  }
  setLimitMiB(value: number): void {
    if (!Number.isSafeInteger(value) || value < 64 || value > 1_048_576) throw new Error('总额度须为 64–1048576 MiB 的整数')
    this.db.prepare("INSERT OR REPLACE INTO attachment_settings(key,value) VALUES ('limitMiB',?)").run(value)
  }
  /** Metadata only; no content hashing or loading all file bytes for the settings page. */
  async storedEntries(): Promise<Array<AttachmentDelivery & { createdAt: number; directory: string }>> {
    const owners = this.privateRoot ? this.db.prepare('SELECT DISTINCT companion_id FROM owners').all().map(row => String(row.companion_id)) : ['']
    const entries = []
    for (const owner of owners) {
      const rows = this.existingDatabase(owner)?.prepare('SELECT payload FROM deliveries').all() ?? []
      for (const row of rows) {
        const item = JSON.parse(String(row.payload)) as AttachmentDelivery
        if (!/^[a-f0-9]{64}$/.test(item.id)) throw new Error('附件索引无效，请检查存储')
        const directory = this.directory(item.companionId)
        const createdAt = item.createdAt ?? (await stat(join(directory, item.id)).catch(error => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        }))?.mtimeMs ?? 0
        entries.push({ ...item, createdAt, directory })
      }
    }
    return entries
  }
  /** Caller holds the storage queue and has rechecked pending deliveries/task references. */
  async removeStored(item: AttachmentDelivery): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(item.id)) throw new Error('附件标识无效')
    await unlink(join(this.directory(item.companionId), item.id)).catch(error => { if (error.code !== 'ENOENT') throw error })
    // Keep the record on unlink errors; a missing file can safely be retried after interruption.
    this.database(item.companionId).prepare('DELETE FROM deliveries WHERE id=?').run(item.id)
    if (this.privateRoot) this.db.prepare('DELETE FROM owners WHERE id=?').run(item.id)
  }
  static async openPartitioned(root: string, privateRoot: (id: string) => string): Promise<AttachmentDeliveryService> {
    await mkdir(root,{recursive:true,mode:0o700})
    const path=join(root,'index.sqlite'),db=new DatabaseSync(path)
    db.exec('CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, companion_id TEXT NOT NULL)')
    await chmod(path,0o600)
    return new AttachmentDeliveryService(root,db,privateRoot)
  }
  private directory(owner: string): string { return this.privateRoot ? join(this.privateRoot(owner),'deliveries') : this.grouped ? attachmentOwnerDirectory(this.root,owner) : this.root }
  private database(owner: string): DatabaseSync {
    if(this.closed)throw new Error('附件存储已关闭')
    if(!this.privateRoot)return this.db
    const cached=this.shards.get(owner);if(cached)return cached
    const directory=this.directory(owner);mkdirSync(directory,{recursive:true,mode:0o700})
    const path=join(directory,'deliveries.sqlite'),db=new DatabaseSync(path);chmodSync(path,0o600)
    db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, payload TEXT NOT NULL, size INTEGER NOT NULL)')
    this.shards.set(owner,db);return db
  }
  private existingDatabase(owner:string):DatabaseSync|undefined {
    if(this.privateRoot&&!existsSync(join(this.directory(owner),'deliveries.sqlite'))) {
      this.shards.get(owner)?.close();this.shards.delete(owner)
      this.db.prepare('DELETE FROM owners WHERE companion_id=?').run(owner)
      return undefined
    }
    return this.database(owner)
  }
  async importExisting(item: AttachmentDelivery, data: Buffer): Promise<void> {
    if(!/^[a-f0-9]{64}$/.test(item.id)||data.length!==item.size||createHash('sha256').update(data).digest('hex')!==item.hash)throw new Error('附件迁移校验失败')
    this.database(item.companionId)
    await mkdir(this.directory(item.companionId),{recursive:true,mode:0o700})
    await writeFile(join(this.directory(item.companionId),item.id),data,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error})
    // A crash can leave an unindexed file. Verify it before adopting it on retry.
    await this.bytes(item)
    this.save(item)
  }
  static async open(root: string): Promise<AttachmentDeliveryService> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, 'deliveries.sqlite'), db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, payload TEXT NOT NULL, size INTEGER NOT NULL);')
      return new AttachmentDeliveryService(root, db)
    } catch (error) { db.close(); throw error }
  }
  static async openGrouped(root:string):Promise<AttachmentDeliveryService>{
    const service=await this.open(root)
    try{
      const items=service.db.prepare('SELECT payload FROM deliveries').all().map(row=>JSON.parse(String(row.payload)) as AttachmentDelivery)
      await groupAttachmentFiles(root,items)
      service.grouped=true
      return service
    }catch(error){service.close();throw error}
  }
  async serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const job = (this.queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(work)
    this.queues.set(sessionId, job)
    try { return await job } finally { if (this.queues.get(sessionId) === job) this.queues.delete(sessionId) }
  }
  get(id: string): AttachmentDelivery | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined
    if(this.closed)throw new Error('附件存储已关闭')
    const owner=this.privateRoot ? this.db.prepare('SELECT companion_id FROM owners WHERE id = ?').get(id) : undefined
    if(this.privateRoot&&!owner)return undefined
    const row = this.existingDatabase(String(owner?.companion_id ?? ''))?.prepare('SELECT payload FROM deliveries WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.payload)) as AttachmentDelivery : undefined
  }
  private save(item: AttachmentDelivery): void {
    this.database(item.companionId).prepare('INSERT OR REPLACE INTO deliveries(id,payload,size) VALUES (?,?,?)').run(item.id, JSON.stringify(item), item.size)
    if(this.privateRoot)this.db.prepare('INSERT OR REPLACE INTO owners(id,companion_id) VALUES (?,?)').run(item.id,item.companionId)
  }
  async prepare(input: { companionId: string; sessionId: string; turn: number; cwd: string; path: string; channel: boolean; channelRouteId?: string }, signal: AbortSignal): Promise<AttachmentDelivery> {
    return this.serial('storage', () => this.prepareSnapshot(input, signal))
  }
  private async prepareSnapshot(input: { companionId: string; sessionId: string; turn: number; cwd: string; path: string; channel: boolean; channelRouteId?: string }, signal: AbortSignal): Promise<AttachmentDelivery> {
    signal.throwIfAborted()
    if (!input.path || input.path.length > 4096 || /[\n\r<>`]/.test(input.path)) throw new Error('请提供单个真实文件路径，不要传 Markdown 或 URL')
    const files = await extractOutboundAttachments(`[交付](<${input.path}>)`, input.cwd)
    const file = files[0]
    if (!file) throw new Error('附件不可用：文件必须存在于当前会话目录内、格式受支持且不超过 64 MB。远端 URL 或沙箱文件请先下载到当前目录。')
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let data: Buffer
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > PARTNER_MEDIA_MAX_BYTES) throw new Error('附件不是普通文件或超过 64 MB')
      const buffer = Buffer.alloc(info.size + 1)
      let count = 0
      while (count < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
        if (!bytesRead) break
        count += bytesRead
      }
      const after = await handle.stat()
      if (count !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size || await realpath(file.path) !== file.path) throw new Error('文件正在变化，请生成完成后重试')
      data = buffer.subarray(0, count)
    } finally { await handle.close() }
    signal.throwIfAborted()
    const hash = createHash('sha256').update(data).digest('hex')
    const id = createHash('sha256').update(JSON.stringify([input.companionId,input.sessionId,input.turn,file.name,hash])).digest('hex')
    const existing = this.get(id)
    if (existing) return existing
    const owners=this.privateRoot ? this.db.prepare('SELECT DISTINCT companion_id FROM owners').all().map(row=>String(row.companion_id)) : ['']
    const used = owners.reduce((sum,owner)=>sum+Number(this.existingDatabase(owner)?.prepare('SELECT COALESCE(SUM(size),0) AS total FROM deliveries').get()!.total ?? 0),0)
    if (used + data.length > this.limitMiB * 1024 * 1024) throw new Error(`附件交付副本额度不足：已用 ${(used / 1024 / 1024).toFixed(1)} / ${this.limitMiB} MiB，本次需要 ${(data.length / 1024 / 1024).toFixed(1)} MiB。请在伙伴设置 → 基本设置 → 附件存储调整额度或清理历史副本；未发送文件`)
    this.database(input.companionId)
    await mkdir(this.directory(input.companionId),{recursive:true,mode:0o700})
    await writeFile(join(this.directory(input.companionId), id), data, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const item: AttachmentDelivery = { id, companionId: input.companionId, sessionId: input.sessionId, name: file.name, mediaType: file.mediaType, kind: file.kind, size: data.length, hash, createdAt: Date.now(), channel: input.channel ? 'pending' : 'none', ...(input.channelRouteId ? {channelRouteId:input.channelRouteId} : {}) }
    await this.bytes(item)
    this.save(item)
    return item
  }
  async bytes(item: AttachmentDelivery): Promise<Buffer> {
    if(!/^[a-f0-9]{64}$/.test(item.id))throw new Error('附件标识无效')
    const data = await readFile(join(this.directory(item.companionId), item.id))
    if (data.length !== item.size || createHash('sha256').update(data).digest('hex') !== item.hash) throw new Error('交付附件校验失败，请重新提交原文件')
    return data
  }
  /** Use the immutable delivery snapshot, never a different companion's workspace path. */
  async outbound(item: AttachmentDelivery): Promise<PartnerOutboundAttachment> {
    await this.bytes(item)
    return { path: join(this.directory(item.companionId), item.id), name: item.name, kind: item.kind, mediaType: item.mediaType }
  }
  async deliver(item: AttachmentDelivery, send: (file: PartnerOutboundAttachment) => Promise<void>): Promise<AttachmentDelivery> {
    return this.serial('storage', async () => {
      const current = this.get(item.id)
      if (!current) throw new Error('交付副本已清理，请从原文件重新提交')
      try { return await this.deliverSnapshot(current, send) }
      finally { Object.assign(item, current) }
    })
  }
  private async deliverSnapshot(item: AttachmentDelivery, send: (file: PartnerOutboundAttachment) => Promise<void>): Promise<AttachmentDelivery> {
    if (item.channel === 'none' || item.channel === 'sent') return item
    await this.bytes(item)
    try {
      await send({ path: join(this.directory(item.companionId),item.id), name:item.name, kind:item.kind, mediaType:item.mediaType })
      item.channel = 'sent'; this.save(item)
    } catch (error) {
      item.channel = 'failed'; this.save(item)
      throw error
    }
    return item
  }
  async freeze(): Promise<void> { await Promise.allSettled(this.queues.values()); this.close() }
  close(): void { if(this.closed)return;this.closed=true;for(const db of this.shards.values())db.close();this.db.close() }
}
