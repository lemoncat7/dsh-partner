/** A unified transport is not a grant to every operation behind it. */
const READ_OPERATIONS = new Set(['knowledge_base_search', 'knowledge_search', 'knowledge_read'])

export function observationKnowledgeEntryDenial(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '知识库入口参数无效'
  const args = input as Record<string, unknown>
  if (args.action === 'list') return undefined
  if ((args.action === 'describe' || args.action === 'call') && typeof args.tool === 'string' && READ_OPERATIONS.has(args.tool)) return undefined
  return '关注检查只能通过 knowledge 入口检索和读取知识文档；不能修改知识库或访问笔记。记录仅使用手动配置的 recordTarget 和专用记录工具。'
}
