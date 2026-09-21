import type { McpConfig } from './domain.js'
import { unwrapMcpConfig } from './config.js'

const PREFIX = '{{DSH_MCP_SAVED:'
const marker = (path: string) => `${PREFIX}${encodeURIComponent(path)}}}`

/** Arbitrary command arguments may contain secrets; mask all of them by default. */
export function editableMcpConfig(config: McpConfig): McpConfig {
  const result = structuredClone(config)
  for (const field of ['headers', 'env'] as const) {
    if (result[field]) for (const key of Object.keys(result[field]!)) result[field]![key] = marker(`${field}/${key}`)
  }
  if (result.args) result.args = result.args.map((_arg, index) => marker(`args/${index}`))
  if (result.url && (new URL(result.url).search || new URL(result.url).hash)) result.url = marker('url')
  return result
}

/** A saved-value reference can only preserve the same field in the same server. */
export function restoreMcpConfig(value: unknown, previous?: McpConfig): Record<string, unknown> {
  const input = unwrapMcpConfig(value)
  const masked = previous ? editableMcpConfig(previous) : undefined
  function restore(next: unknown, old: unknown, view: unknown): unknown {
    if (typeof next === 'string' && next.startsWith(PREFIX)) {
      if (typeof old !== 'string' || next !== view || !next.endsWith('}}')) throw Error('已保存凭据的占位符无效；请重新打开编辑，或填写新的实际值')
      return old
    }
    if (Array.isArray(next)) return next.map((item, index) => restore(item, Array.isArray(old) ? old[index] : undefined, Array.isArray(view) ? view[index] : undefined))
    if (next && typeof next === 'object') return Object.fromEntries(Object.entries(next).map(([key, item]) => [key, restore(item, old && typeof old === 'object' ? (old as Record<string, unknown>)[key] : undefined, view && typeof view === 'object' ? (view as Record<string, unknown>)[key] : undefined)]))
    return next
  }
  return restore(input, previous, masked) as Record<string, unknown>
}
