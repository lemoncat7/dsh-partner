import { readFile, rm, lstat, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicJson } from './atomic.js'
import { copyVerified, exists, fileHash, safeTree } from './safe-files.js'
import { storageLayout } from './layout.js'
import { isLegacyMemoryBackup, legacyMemoryBackups } from './legacy-backups.js'
import { SplitStatePersistence } from './split-state.js'

type Source = { kind: 'state' | 'inbox' | 'inbox-wal' | 'inbox-shm' | 'deliveries' | 'skills' } | { kind: 'private'; owner: string; name: string }
interface Entry { source: Source; digest: string }
interface Archive { version: 1; transactionId: string; entries: Entry[] }
export interface CleanupResult { pending: number; removed: number; warnings: string[] }
const validId = (id: string): void => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error('备份事务标识无效') }
function sourcePath(statePath: string, root: string, source: Source): string {
  const layout = storageLayout(resolve(statePath), resolve(root))
  switch (source.kind) {
    case 'state': return resolve(statePath)
    case 'inbox': return join(layout.legacyPublic, 'partner-inbox.sqlite')
    case 'inbox-wal': return join(layout.legacyPublic, 'partner-inbox.sqlite-wal')
    case 'inbox-shm': return join(layout.legacyPublic, 'partner-inbox.sqlite-shm')
    case 'deliveries': return join(layout.legacyPublic, 'attachment-deliveries')
    case 'skills': return layout.legacySkills
    case 'private':
      if (!['memory', 'concerns'].includes(source.name) && !isLegacyMemoryBackup(source.name)) throw Error('非迁移范围目录，拒绝清理')
      return join(layout.legacyCompanion(source.owner), source.name)
    default: throw Error('未知迁移源，拒绝清理')
  }
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  const dirs=async(p:string):Promise<void>=>{const entry=await lstat(p);hash.update(JSON.stringify([relative(path,p),entry.isDirectory()?'directory':'file']));if(entry.isDirectory())for(const name of (await readdir(p)).sort())await dirs(join(p,name))}
  await safeTree(path)
  await dirs(path)
  for (const file of await safeTree(path)) hash.update(JSON.stringify([relative(path, file), await fileHash(file)]))
  return hash.digest('hex')
}
export function archiveRoot(statePath: string, id: string): string {
  validId(id)
  return join(dirname(resolve(statePath)), 'migration-backups', id)
}
/** Called under the migration write gate. Complete backups precede activation. */
export async function prepareSourceArchive(statePath: string, root: string, id: string, owners: string[]): Promise<void> {
  const backup = archiveRoot(statePath, id)
  const sources: Source[] = [{kind:'state'}, {kind:'inbox'}, {kind:'inbox-wal'}, {kind:'inbox-shm'}, {kind:'deliveries'}, {kind:'skills'}]
  const layout = storageLayout(resolve(statePath), resolve(root))
  for (const owner of owners) for (const name of ['memory', 'concerns', ...await legacyMemoryBackups(layout.legacyCompanion(owner))]) sources.push({kind:'private', owner, name})
  const entries: Entry[] = []
  for (const source of sources) {
    const path = sourcePath(statePath, root, source)
    if (!await exists(path)) continue
    const target = join(backup, 'originals', String(entries.length))
    await copyVerified(path, target)
    const fingerprint = await digest(path)
    if (fingerprint !== await digest(target)) throw Error('完整备份校验失败')
    entries.push({source, digest:fingerprint})
  }
  await atomicJson(join(backup, 'archive.json'), {version:1, transactionId:id, entries} satisfies Archive)
}
/** No source is removed until both the active version and its backup verify.
 * A changed source or incomplete backup is left intact and reported, not guessed.
 * Only called while services are stopped, never as an automatic startup sweep.
 */
export async function cleanupArchivedSources(statePath: string, root: string, id: string): Promise<CleanupResult> {
  const backup = archiveRoot(statePath, id)
  const config = JSON.parse(await readFile(join(storageLayout(resolve(statePath),resolve(root)).legacyPublic,'storage-config.json'),'utf8'))
  if (config.storageVersion !== 1 || config.transactionId !== id || config.workspaceRoot !== resolve(root)) throw Error('迁移版本未提交，禁止清理原文件')
  const layout=storageLayout(resolve(statePath),resolve(root))
  await new SplitStatePersistence(layout.publicRoot,layout.privateRoot).read()
  const archive = JSON.parse(await readFile(join(backup, 'archive.json'),'utf8')) as Archive
  if (archive.version !== 1 || archive.transactionId !== id || !Array.isArray(archive.entries)) throw Error('备份清单无效')
  const result: CleanupResult = {pending:0, removed:0, warnings:[]}
  for (const [index, entry] of archive.entries.entries()) {
    try {
      const path = sourcePath(statePath, root, entry.source)
      if (!await exists(path)) continue
      const saved = join(backup, 'originals', String(index))
      if (!await exists(saved) || await digest(saved) !== entry.digest || await digest(path) !== entry.digest) throw Error('源文件或备份已变化')
      await rm(path, { recursive:true, force:false })
      result.removed++
    } catch { result.pending++; result.warnings.push(`第 ${index+1} 项原路径未清理，已保留，请核查备份或文件占用。`) }
  }
  await atomicJson(join(backup, 'cleanup.json'), result)
  return result
}
