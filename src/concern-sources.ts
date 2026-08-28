import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface ConcernSource {
  kind: 'file' | 'knowledge'
  label: string
  detail: string
  token: string
}

const EXCLUDED_DIRECTORIES = new Set([
  '.cache', '.git', '.svn', 'concerns', 'memory', 'node_modules',
])
const MAX_DIRECTORY_COUNT = 120
const MAX_ENTRY_COUNT = 1_500
const MAX_DEPTH = 6

/** Bounded, symlink-free discovery for files that a partner can safely reference. */
export async function listConcernFileSources(root: string, query = '', limit = 24): Promise<ConcernSource[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 40))
  const normalizedQuery = fold(query)
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  const matches: Array<ConcernSource & { score: number }> = []
  let directories = 0
  let entries = 0

  while (queue.length > 0 && directories < MAX_DIRECTORY_COUNT && entries < MAX_ENTRY_COUNT) {
    const current = queue.shift()
    if (current === undefined) break
    directories += 1
    let children: Dirent[]
    try { children = await readdir(current.path, { withFileTypes: true }) }
    catch { continue }
    children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const child of children) {
      entries += 1
      if (entries > MAX_ENTRY_COUNT) break
      if (child.name.startsWith('.') || child.isSymbolicLink()) continue
      const childPath = join(current.path, child.name)
      if (child.isDirectory()) {
        if (current.depth < MAX_DEPTH && !EXCLUDED_DIRECTORIES.has(child.name.toLocaleLowerCase('en-US'))) {
          queue.push({ path: childPath, depth: current.depth + 1 })
        }
        continue
      }
      if (!child.isFile()) continue
      const locator = relative(root, childPath).split(sep).join('/')
      if (locator.includes('"')) continue
      const score = matchScore(locator, normalizedQuery)
      if (score < 0) continue
      matches.push({
        kind: 'file',
        label: locator,
        detail: locator.includes('/') ? `当前会话文件 · ${locator.slice(0, locator.lastIndexOf('/'))}` : '当前会话文件',
        token: fileToken(locator),
        score,
      })
    }
  }

  return matches
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, boundedLimit)
    .map(({ score: _score, ...source }) => source)
}

export function fileToken(locator: string): string {
  return /\s/u.test(locator) ? `@"${locator.replaceAll('"', '\\"')}"` : `@${locator}`
}

function matchScore(value: string, query: string): number {
  if (!query) return 0
  const folded = fold(value)
  const index = folded.indexOf(query)
  if (index < 0) return -1
  const name = folded.slice(folded.lastIndexOf('/') + 1)
  return (name === query ? 80 : name.startsWith(query) ? 60 : name.includes(query) ? 40 : 20) - index * .01
}

function fold(value: string): string {
  return value.trim().replace(/^@(?:"|知识库\[)?/u, '').toLocaleLowerCase('zh-CN')
}
