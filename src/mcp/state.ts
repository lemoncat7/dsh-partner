import type { PartnerState } from '../domain.js'

/** Validates persisted optional fields without rewriting older partner data. */
export function validateMcpState(state: Partial<PartnerState>): void {
  if (state.mcpServers !== undefined && (!Array.isArray(state.mcpServers) || state.mcpServers.length > 50)) throw Error('Invalid MCP server state')
  if (state.mcpBindings !== undefined && !Array.isArray(state.mcpBindings)) throw Error('Invalid MCP bindings')
  const ids = new Set<string>()
  for (const server of state.mcpServers ?? []) {
    if (!server || typeof server.id !== 'string' || ids.has(server.id) || typeof server.name !== 'string' || typeof server.credentialId !== 'string' || typeof server.enabled !== 'boolean' || !['stdio', 'streamable-http'].includes(server.transport) || !Number.isSafeInteger(server.revision) || server.revision < 1 || !Number.isFinite(server.updatedAt) || !Array.isArray(server.tools) || server.tools.length > 200) throw Error('Invalid MCP server record')
    const names = new Set<string>()
    for (const tool of server.tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || !tool.inputSchema || tool.inputSchema.type !== 'object' || (tool.description !== undefined && typeof tool.description !== 'string')) throw Error('Invalid MCP tool catalog')
      names.add(tool.name)
    }
    ids.add(server.id)
  }
  const companions = new Set(state.companions?.map(c => c.id)), pairs = new Set<string>()
  for (const binding of state.mcpBindings ?? []) {
    if (!binding || !ids.has(binding.serverId) || !companions.has(binding.companionId)) throw Error('Invalid MCP authorization')
    const pair = `${binding.companionId}\0${binding.serverId}`
    if (pairs.has(pair)) throw Error('Duplicate MCP authorization')
    pairs.add(pair)
  }
}
