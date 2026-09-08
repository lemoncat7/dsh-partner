import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, realpath, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { extractOutboundAttachments } from '../channels/outbound-media.js'
import { PARTNER_MEDIA_MAX_BYTES, type PartnerOutboundAttachment } from '../channel-message.js'

export interface AttachmentDelivery {
  id: string; companionId: string; sessionId: string; name: string; mediaType: string
  kind: 'image' | 'file'; size: number; hash: string; channel: 'pending' | 'sent' | 'failed' | 'none'
}
const MAX_STORED_BYTES = 512 * 1024 * 1024

/** Explicit immutable deliveries, separate from mutable workspace files and board state. */
export class AttachmentDeliveryService {
  private queues = new Map<string, Promise<unknown>>()
  private constructor(private readonly root: string, private readonly db: DatabaseSync) {}
  static async open(root: string): Promise<AttachmentDeliveryService> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(root, 'deliveries.sqlite'), db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, payload TEXT NOT NULL, size INTEGER NOT NULL);')
      return new AttachmentDeliveryService(root, db)
    } catch (error) { db.close(); throw error }
  }
  async serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const job = (this.queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(work)
    this.queues.set(sessionId, job)
    try { return await job } finally { if (this.queues.get(sessionId) === job) this.queues.delete(sessionId) }
  }
  get(id: string): AttachmentDelivery | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined
    const row = this.db.prepare('SELECT payload FROM deliveries WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.payload)) as AttachmentDelivery : undefined
  }
  private save(item: AttachmentDelivery): void {
    this.db.prepare('INSERT OR REPLACE INTO deliveries(id,payload,size) VALUES (?,?,?)').run(item.id, JSON.stringify(item), item.size)
  }
  async prepare(input: { companionId: string; sessionId: string; turn: number; cwd: string; path: string; channel: boolean }, signal: AbortSignal): Promise<AttachmentDelivery> {
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
    const used = Number(this.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM deliveries').get()!.total)
    if (used + data.length > MAX_STORED_BYTES) throw new Error('附件交付存储已达到 512 MB，请先由管理员清理历史交付；未发送文件')
    await writeFile(join(this.root, id), data, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const item: AttachmentDelivery = { id, companionId: input.companionId, sessionId: input.sessionId, name: file.name, mediaType: file.mediaType, kind: file.kind, size: data.length, hash, channel: input.channel ? 'pending' : 'none' }
    await this.bytes(item)
    this.save(item)
    return item
  }
  async bytes(item: AttachmentDelivery): Promise<Buffer> {
    const data = await readFile(join(this.root, item.id))
    if (data.length !== item.size || createHash('sha256').update(data).digest('hex') !== item.hash) throw new Error('交付附件校验失败，请重新提交原文件')
    return data
  }
  async deliver(item: AttachmentDelivery, send: (file: PartnerOutboundAttachment) => Promise<void>): Promise<AttachmentDelivery> {
    if (item.channel === 'none' || item.channel === 'sent') return item
    await this.bytes(item)
    try {
      await send({ path: join(this.root,item.id), name:item.name, kind:item.kind, mediaType:item.mediaType })
      item.channel = 'sent'; this.save(item)
    } catch (error) {
      item.channel = 'failed'; this.save(item)
      throw error
    }
    return item
  }
  close(): void { this.db.close() }
}
