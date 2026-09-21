import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { PartnerState } from '../domain.js'
import { atomicJson } from './atomic.js'

const privateKeys = ['companions', 'channels', 'pairings', 'sessions', 'heartbeatStates', 'skillBindings', 'mcpBindings', 'schedules', 'executionRuns', 'notificationDeliveries'] as const
type PrivateKey = typeof privateKeys[number]
export function privateStateOwners(state: PartnerState): string[] {
  const owners = new Set(state.companions.map(c => c.id))
  const channels = new Map(state.channels.map(c => [c.id, c.companionId]))
  for (const key of privateKeys) for (const item of state[key] ?? []) {
    const row = item as unknown as Record<string, unknown>
    const owner = key === 'companions' ? row.id : key === 'pairings' ? channels.get(String(row.channelId)) : key === 'executionRuns' ? row.ownerCompanionId : row.companionId
    if (typeof owner !== 'string' || !owner) throw Error(`私有数据 ${key} 找不到所属伙伴`)
    owners.add(owner)
  }
  return [...owners]
}
interface Commit { version: 1; publicState: Partial<PartnerState>; privateRefs: { id: string; hash: string }[] }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Immutable private revisions + one atomic public manifest. Readers can never
 * observe half of a cross-companion update. Public manifest contains references
 * only, not copies of identity, channel configuration or private runtime state.
 */
export class SplitStatePersistence {
  constructor(readonly publicRoot: string, private readonly privateRoot: (id: string) => string) {}
  async read(): Promise<PartnerState> {
    const commit = JSON.parse(await readFile(join(this.publicRoot, 'state.json'), 'utf8')) as Commit
    if (commit.version !== 1 || !Array.isArray(commit.privateRefs)) throw Error('数据提交清单无效')
    const result = structuredClone(commit.publicState) as PartnerState
    for (const key of privateKeys) (result as unknown as Record<string, unknown>)[key] = []
    const ids = new Set<string>()
    for (const ref of commit.privateRefs) {
      if (ids.has(ref.id) || !/^[a-f0-9]{64}$/.test(ref.hash)) throw Error('私有数据引用无效')
      ids.add(ref.id)
      const text = await readFile(join(this.privateRoot(ref.id), 'state', `${ref.hash}.json`), 'utf8')
      if (hash(text) !== ref.hash) throw Error('私有数据校验失败，拒绝回退旧配置')
      const data = JSON.parse(text) as Pick<PartnerState, PrivateKey>
      for (const key of privateKeys) {
        const rows = data[key] ?? []
        if (!Array.isArray(rows)) throw Error('私有数据字段无效')
        ;(result[key] as unknown[]).push(...rows)
      }
    }
    return result
  }
  async write(state: PartnerState): Promise<void> {
    const publicState = structuredClone(state) as Partial<PartnerState>
    for (const key of privateKeys) delete publicState[key]
    const empty = ():Record<PrivateKey,unknown[]> => ({companions:[],channels:[],pairings:[],sessions:[],heartbeatStates:[],skillBindings:[],mcpBindings:[],schedules:[],executionRuns:[],notificationDeliveries:[]})
    const owners = new Map(state.companions.map(c => [c.id, empty()]))
    const channels = new Map(state.channels.map(c => [c.id, c.companionId]))
    for (const key of privateKeys) for (const item of state[key] ?? []) {
      const row = item as unknown as Record<string, unknown>
      const owner = key === 'companions' ? row.id : key === 'pairings' ? channels.get(String(row.channelId)) : key === 'executionRuns' ? row.ownerCompanionId : row.companionId
      if (typeof owner !== 'string' || !owner) throw Error(`私有数据 ${key} 找不到所属伙伴，拒绝丢弃或复制到公共配置`)
      this.privateRoot(owner) // Validate even legacy owners whose companion was deleted.
      if (!owners.has(owner)) owners.set(owner, empty())
      const bucket = owners.get(owner)!
      bucket[key].push(item)
    }
    const refs: Commit['privateRefs'] = []
    for (const [id, data] of owners) {
      const text = JSON.stringify(data) + '\n', digest = hash(text)
      const directory = join(this.privateRoot(id), 'state')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, digest + '.json')
      try {
        if (await readFile(path, 'utf8') !== text) throw Error('私有数据版本冲突')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Publish only a complete, synced revision; interrupted writes leave no
        // partial content-addressed file that could poison the next retry.
        await atomicJson(path, data)
      }
      refs.push({ id, hash: digest })
    }
    await atomicJson(join(this.publicRoot, 'state.json'), { version: 1, publicState, privateRefs: refs } satisfies Commit)
    // Cleanup is post-commit and cannot turn success into an apparent failure.
    // Keep current and previous revision; migration backups live elsewhere.
    for (const ref of refs) {
      const directory = join(this.privateRoot(ref.id), 'state')
      const files = await readdir(directory).catch(() => [] as string[])
      // Only clean our content-addressed files; never user files.
      const old = files.filter(name => /^[a-f0-9]{64}\.json$/.test(name) && name !== ref.hash + '.json')
      for (const name of old.slice(0, Math.max(0, old.length - 1))) await unlink(join(directory, name)).catch(() => {})
    }
  }
}
