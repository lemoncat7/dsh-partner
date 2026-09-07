import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** Remove only the dedicated space registration; never files or session logs. */
export async function removeOwnedWorkspace(registry: Pick<WorkspaceRegistry, 'list' | 'delete'>, cwd: string, companionId: string, sharedPaths: readonly string[]): Promise<void> {
  if (!companionId || companionId === '.' || companionId === '..' || /[/\\]/.test(companionId)) throw new Error('伙伴目录标识无效')
  if (basename(cwd) !== companionId || basename(dirname(cwd)) !== 'partners') throw new Error('拒绝清理非伙伴专属目录')
  try {
    const entry = await lstat(cwd)
    if (entry.isSymbolicLink() || !entry.isDirectory()) return
  } catch (error) { if (!missing(error)) throw error }
  const canonical = join(await canonicalOrMissing(dirname(cwd)), companionId)
  for (const path of sharedPaths) if (await canonicalOrMissing(path) === canonical) return
  const workspace = registry.list().find(item => item.path === canonical)
  if (workspace) await registry.delete(workspace.id)
}

async function canonicalOrMissing(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) { if (missing(error)) return resolve(path); throw error }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
