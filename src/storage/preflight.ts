import { access, lstat, readdir, readFile, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PartnerState } from '../domain.js'
import { storageLayout, storageVersion, TARGET_STORAGE_VERSION } from './layout.js'
import { migrationPath, storageMigrations } from './migrations/index.js'
import { legacyMemoryBackups } from './legacy-backups.js'

export interface StorageCheckItem {
  label: string
  source: string
  target: string
  files: number
  bytes: number
  exists: boolean
}
export interface StorageInspection {
  currentVersion: number
  targetVersion: number
  migrationAvailable: boolean
  consistentSnapshot: false
  items: StorageCheckItem[]
  blockers: string[]
  notices: string[]
  checkedAt: number
  steps: { id: string; from: number; to: number; title: string; available: boolean }[]
}

/** Read-only inventory. Never opens SQLite or reads config/credential payloads.
 * Live sizes are estimates; the eventual migration must recheck under a gate.
 */
export class StoragePreflight {
  private pending: Promise<StorageInspection> | undefined
  constructor(private readonly statePath: string, private readonly root: string, private readonly version: number, private readonly snapshot: () => PartnerState) {}

  inspect(): Promise<StorageInspection> {
    if (this.pending) return this.pending
    const work = this.scan().finally(() => { if (this.pending === work) this.pending = undefined })
    this.pending = work
    return work
  }

  private async scan(): Promise<StorageInspection> {
    const state = this.snapshot()
    const layout = storageLayout(resolve(this.statePath), resolve(this.root))
    const result: StorageInspection = {
      currentVersion: storageVersion(this.version), targetVersion: TARGET_STORAGE_VERSION,
      migrationAvailable: this.version<TARGET_STORAGE_VERSION, consistentSnapshot: false, items: [], blockers: [],
      steps: migrationPath(storageMigrations, this.version, TARGET_STORAGE_VERSION).map(step => ({ id: step.id, from: step.from, to: step.to, title: step.title, available: !!step.execute && !!step.verify })),
      notices: ['检查不会修改配置或数据库；运行中的文件数量与大小仅作预估。', '版本由迁移流程维护，请勿手动修改；公共和私有数据全部校验后才提交版本。', '凭据、宿主会话与知识库正文不搬动；工作文件和记录文档保持原位。'], checkedAt: Date.now(),
    }
    if(this.version===TARGET_STORAGE_VERSION){result.notices.push(`已使用新版公共目录：${layout.publicRoot}`);return result}
    let recoveryId:string|undefined
    try {const journal=JSON.parse(await readFile(join(layout.legacyPublic,'storage-migration.json'),'utf8'));if(typeof journal.id==='string')recoveryId=journal.id}catch(error){if(!missing(error))result.blockers.push('迁移恢复记录无法读取')}
    let budget = 50_000
    const inspectTree = async (path: string, device?: number): Promise<{ exists: boolean; files: number; bytes: number }> => {
      if (--budget < 0) throw Error('文件数量超过检查上限，请先核对目录范围')
      let entry
      try { entry = await lstat(path) } catch (error) { if (missing(error)) return { exists: false, files: 0, bytes: 0 }; throw error }
      if (entry.isSymbolicLink()) throw Error('包含符号链接，需人工确认')
      if (device !== undefined && entry.dev !== device) throw Error('跨文件系统目录，需人工确认')
      if (entry.isFile()) { await access(path, constants.R_OK); return { exists: true, files: 1, bytes: entry.size } }
      if (!entry.isDirectory()) throw Error('包含特殊文件，需人工确认')
      let files = 0, bytes = 0
      for (const child of await readdir(path)) {
        const value = await inspectTree(join(path, child), entry.dev)
        files += value.files; bytes += value.bytes
      }
      return { exists: true, files, bytes }
    }
    const inspect = async (label: string, source: string, target: string) => {
      try {
        await assertAncestors(source)
        const value = await inspectTree(source)
        result.items.push({ label, source, target, ...value })
      } catch (error) { result.blockers.push(`${label}：${safeError(error)}`) }
    }
    const targets = [layout.publicRoot]
    await inspect('公共配置（待拆分私有字段）', resolve(this.statePath), join(layout.publicRoot, 'state'))
    await inspect('Skill 安装库', layout.legacySkills, join(layout.publicRoot, 'skills'))
    await inspect('消息索引（待按伙伴拆分）', join(layout.legacyPublic, 'partner-inbox.sqlite'), join(layout.publicRoot, 'indexes'))
    await inspect('附件交付（待按伙伴拆分）', join(layout.legacyPublic, 'attachment-deliveries'), join(layout.publicRoot, 'indexes'))
    const seen = new Set<string>()
    for (const companion of state.companions) {
      if (seen.has(companion.id)) { result.blockers.push('伙伴 ID 重复，不能迁移'); continue }
      seen.add(companion.id)
      let source: string, target: string
      try { source = layout.legacyCompanion(companion.id); target = layout.privateRoot(companion.id) }
      catch { result.blockers.push('伙伴 ID 无效，不能迁移'); continue }
      targets.push(target)
      await inspect(`${companion.name} · 记忆`, join(source, 'memory'), join(target, 'memory'))
      await inspect(`${companion.name} · 关注`, join(source, 'concerns'), join(target, 'concerns'))
      try {
        for(const name of await legacyMemoryBackups(source)) {
          await inspect(`${companion.name} · ${name}`,join(source,name),join(target,'backups','legacy-memory',name))
          result.notices.push(`${companion.name} · ${name} 原样归档，不合并到当前记忆`)
        }
      } catch (error) { if (!missing(error)) result.blockers.push(`${companion.name} · 备份检查：${safeError(error)}`) }
    }
    const total = result.items.reduce((sum, item) => sum + item.bytes, 0)
    for (const target of targets) {
      try {
        await assertAncestors(target)
        let ancestor = target
        try {
          await lstat(target)
          let owned=false
          if(recoveryId)try{const marker=JSON.parse(await readFile(join(target,'migration-owner.json'),'utf8'));owned=marker.transactionId===recoveryId}catch{}
          if(!owned)result.blockers.push(`目标目录已存在，不允许覆盖：${target}`)
          else result.notices.push(`发现未提交的迁移，可安全重试：${target}`)
        }
        catch (error) { if (!missing(error)) throw error }
        while (true) {
          try { await lstat(ancestor); break } catch (error) { if (!missing(error)) throw error; ancestor = dirname(ancestor) }
        }
        await access(ancestor, constants.W_OK | constants.X_OK)
        const fs = await statfs(ancestor)
        // Deliberately conservative until an exact per-volume copy plan exists.
        if (fs.bavail * fs.bsize < total * 3) result.blockers.push(`目标磁盘可用空间不足（含完整备份）：${target}`)
      } catch (error) { result.blockers.push(`目标目录 ${target}：${safeError(error)}`) }
    }
    result.notices.push(`已识别 ${state.companions.length} 位伙伴；私有配置还需从公共 state.json 按归属拆分，不是整份复制到每个伙伴。`)
    result.migrationAvailable=result.blockers.length===0
    return result
  }
}

async function assertAncestors(path: string): Promise<void> {
  const paths: string[] = []
  for (let current = resolve(path);;) { paths.push(current); const parent = dirname(current); if (parent === current) break; current = parent }
  for (const current of paths.reverse()) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('路径含符号链接，需人工确认') }
    catch (error) { if (missing(error)) return; throw error }
  }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return '目录读写权限不足'
  if (code) return `文件检查失败（${code}）`
  return error instanceof Error ? error.message : '检查失败'
}
