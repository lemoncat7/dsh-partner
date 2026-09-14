/** A version is a complete public + private layout transition, never one
 * companion. The coordinator supplies the exclusive gate and durable journal.
 */
export interface StorageMigration<Context> {
  id: string
  from: number
  to: number
  title: string
  /** Absent while a step is inspection-only; do not expose an execute button. */
  execute?: (context: Context) => Promise<void>
  verify?: (context: Context) => Promise<void>
}

export function migrationPath<Context>(steps: readonly StorageMigration<Context>[], from: number, to: number): StorageMigration<Context>[] {
  if (![from, to].every(version => Number.isSafeInteger(version) && version >= 0)) throw Error('迁移版本必须是非负整数')
  if (from > to) throw Error('不支持自动降级数据目录')
  const bySource = new Map<number, StorageMigration<Context>>()
  const ids = new Set<string>()
  for (const step of steps) {
    if (!step.id || ids.has(step.id) || bySource.has(step.from)) throw Error('迁移版本注册重复')
    if (!Number.isSafeInteger(step.from) || step.from < 0 || step.to !== step.from + 1) throw Error('迁移必须逐版本递增')
    ids.add(step.id); bySource.set(step.from, step)
  }
  const result: StorageMigration<Context>[] = []
  for (let version = from; version < to; version++) {
    const step = bySource.get(version)
    if (!step) throw Error(`缺少 v${version} → v${version + 1} 迁移脚本`)
    result.push(step)
  }
  return result
}

/** The caller must hold its runtime write gate throughout. On any error stop:
 * reopen the persisted version/journal before retrying (including commit errors).
 * This runner does not guess whether a failed commit reached durable storage.
 */
export async function runMigrationPath<Context>(steps: readonly StorageMigration<Context>[], from: number, to: number, context: Context, commitVersion: (expected: number, next: number, migrationId: string) => Promise<void>): Promise<void> {
  const path = migrationPath(steps, from, to)
  // Refuse incomplete chains before touching even the first step.
  if (path.some(step => !step.execute || !step.verify)) throw Error('迁移链尚未全部实现，拒绝执行')
  for (const step of path) {
    await step.execute!(context)
    await step.verify!(context)
    await commitVersion(step.from, step.to, step.id)
  }
}
