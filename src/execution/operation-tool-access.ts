import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

// file_* is not a plugin-specific namespace. Only SSH's known legacy transfer
// operations belong to its entry; an unrelated file tool must not grant SSH.
const SSH_FILE_OPERATIONS = new Set([
  'file_endpoint_list', 'file_directory_list', 'file_transfer_start',
  'file_transfer_status', 'file_transfer_cancel', 'file_download_to_local', 'file_upload_from_local',
])
const ENTRIES = [
  { name: 'knowledge', operation: (name: string) => name.startsWith('knowledge_') },
  { name: 'ssh', operation: (name: string) => name.startsWith('ssh_') || SSH_FILE_OPERATIONS.has(name) },
]

/** Adapt legacy allowlists while retaining operation-level and parent-scope limits. */
export function operationToolAccess(requested: readonly string[], visible: readonly string[]) {
  const names = new Set(requested)
  const migrated = new Map(ENTRIES.filter(entry => visible.includes(entry.name) && !names.has(entry.name)
    && requested.some(entry.operation)).map(entry => [entry.name, new Set(requested.filter(entry.operation))]))
  const allowed = [...new Set(visible.filter(name => name !== 'run_code' && (names.has(name) || migrated.has(name))))]
  const allowedNames = new Set(allowed)
  return {
    allowed,
    denial(name: string, input: unknown): string | undefined {
      if (!allowedNames.has(name)) return '该工具不在本次任务的 allowed-tools 或当前可见范围内。'
      const operations = migrated.get(name)
      if (!operations) return undefined
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const args = input as Record<string, unknown>
        if (args.action === 'list') return undefined
        if ((args.action === 'describe' || args.action === 'call') && typeof args.tool === 'string' && operations.has(args.tool)) return undefined
      }
      return `该 ${name} 操作不在本次任务的 allowed-tools 中；统一入口不会扩大原工具授权。`
    },
  }
}

/** Model visibility and execution use one policy, including scope-local MCP tools. */
export function restrictExecutionTools(ctx: Context & { tools: ToolRuntime }, agent: Agent, requested: readonly string[]): void {
  const policy = operationToolAccess(requested, ctx.tools.schemas(agent).map(tool => tool.name))
  const allowed = new Set(policy.allowed)
  ctx.tools.guard(exec => policy.denial(exec.name, exec.arguments))
  // tools.restrict rejects same-scope MCP names. Filter the assembled native
  // schema instead and enforce every real call with the monotonic guard above.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, tools: assembly.tools.filter(tool => allowed.has(tool.name)) }
  })
}
