import { randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { parseMcpConfig } from './config.js'
import type { McpConfig } from './domain.js'

// Credential key segments must start with a letter; bare UUIDs may start with a digit.
// Only new IDs use this prefix. Existing IDs retain their original vault address.
export function createMcpCredentialId(): string {
  return `mcp-${randomUUID()}`
}

export class McpCredentials {
  constructor(private readonly provider: CredentialProvider) {}
  async read(id: string): Promise<McpConfig> {
    const record = await this.provider.readRecord(credentialKey('dsh-partner-mcp', id))
    if (!record || record.kind !== 'grant') throw Error('MCP 凭据不可用，请重新保存配置')
    return parseMcpConfig(record.payload)
  }
  async write(id: string, config: McpConfig): Promise<void> {
    await this.provider.modifyRecord(credentialKey('dsh-partner-mcp', id), async () => ({ kind: 'grant', payload: config }))
  }
  async delete(id: string): Promise<void> { await this.provider.deleteRecord(credentialKey('dsh-partner-mcp', id)) }
}
