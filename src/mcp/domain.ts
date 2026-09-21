export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  credentialId: string
  revision: number
  tools: McpTool[]
  updatedAt: number
  refreshedAt?: number
  error?: string
}
export interface McpBinding { companionId: string; serverId: string }
export interface McpConfig {
  transport: McpServer['transport']
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}
export type McpServerView = Omit<McpServer, 'credentialId'>
export interface McpCatalog { servers: McpServerView[]; bindings: McpBinding[] }
export interface McpEditView { name: string; revision: number; config: McpConfig }
