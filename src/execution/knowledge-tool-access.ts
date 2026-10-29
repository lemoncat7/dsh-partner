/** Migrate a legacy operation allowlist without granting the entire gateway. */
export function knowledgeToolAccess(requested: readonly string[], visible: readonly string[]) {
  const names = new Set(requested)
  const migrate = visible.includes('knowledge') && !names.has('knowledge') && requested.some(name => name.startsWith('knowledge_'))
  const allowed = visible.filter(name => names.has(name) || (migrate && name === 'knowledge'))
  return {
    allowed,
    denial(name: string, input: unknown): string | undefined {
      if (!migrate || name !== 'knowledge') return undefined
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const args = input as Record<string, unknown>
        if (args.action === 'list') return undefined
        if ((args.action === 'describe' || args.action === 'call') && typeof args.tool === 'string' && names.has(args.tool)) return undefined
      }
      return '该知识库操作不在本次任务的 allowed-tools 中；统一入口不会扩大原工具授权。'
    },
  }
}
