import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerConcern } from './concern-domain.js'

/** Host-owned opt-in, never inferred from a model's claim that a tool is safe.
 * Providers must enforce resource scope, read-only behavior, credential origin,
 * timeouts and bounded pagination in execute. No approval-policy override. */
export interface ObservationSourceRegistry {
  readTools(input: { agent: Agent; concerns: readonly PartnerConcern[] }): Promise<ToolDefinition[]>
}

export function validateObservationSources(tools: ToolDefinition[], existing: Set<string>): ToolDefinition[] {
  if (tools.length > 16) throw new Error('后台只读来源超过 16 个上限')
  const names = new Set(existing)
  for (const tool of tools) {
    if (!/^observation_read_[a-z0-9_]+$/u.test(tool.name) || names.has(tool.name)) throw new Error('后台只读来源名称无效或重复')
    names.add(tool.name)
  }
  return tools
}
