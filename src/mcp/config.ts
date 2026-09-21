import { record, requiredText } from '../core/validation.js'
import type { McpConfig } from './domain.js'

function literal(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw Error(`${field} 必须是有效字符串，最多 ${limit} 字符`)
  return value.trim()
}

function strings(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {}
  const input = record(value, field)
  if (Object.keys(input).length > 64 || Object.values(input).some(v => typeof v !== 'string' || v.length > 8192)) throw Error(`${field} 必须是字符串键值，最多 64 项`)
  return input as Record<string, string>
}

/** Accepts standard mcpServers entries; credentials never enter public state. */
export function parseMcpConfig(value: unknown): McpConfig {
  const input = unwrapMcpConfig(value)
  const transport = input.transport ?? input.type ?? (input.command ? 'stdio' : 'http')
  if (transport === 'http' || transport === 'streamable-http') {
    if (input.url === undefined) throw Error('请填写包含 url 的 HTTP 配置，或包含 command 的 stdio 配置；批量添加请使用「导入 JSON」并包含 mcpServers')
    const url = new URL(literal(input.url, 'url', 4096))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('MCP 地址必须是 HTTP(S)，认证请使用 headers')
    return { transport: 'streamable-http', url: url.href, headers: strings(input.headers, 'headers') }
  }
  if (transport !== 'stdio') throw Error('当前支持 http / streamable-http 和 stdio，不支持旧版 SSE')
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(v => typeof v !== 'string' || v.length > 8192))) throw Error('args 必须是字符串数组，最多 100 项')
  return { transport, command: literal(input.command, 'command', 1024), args: input.args as string[] | undefined ?? [], env: strings(input.env, 'env'), ...(input.cwd ? { cwd: literal(input.cwd, 'cwd', 4096) } : {}) }
}

/** Single-service forms also accept a complete, unambiguous client config. */
export function unwrapMcpConfig(value: unknown): Record<string, unknown> {
  const input = record(value, 'MCP 配置')
  if (!Object.hasOwn(input, 'mcpServers')) return input
  const entries = Object.values(record(input.mcpServers, 'mcpServers'))
  if (entries.length !== 1) throw Error('新增 / 编辑一次只能配置一个服务；多个服务请使用「导入 JSON」')
  return record(entries[0], '服务配置')
}

export function parseMcpImport(value: unknown): Array<{ name: string; config: McpConfig }> {
  const input = record(value, 'JSON')
  if (!Object.hasOwn(input, 'mcpServers')) throw Error('导入 JSON 需要完整的 { "mcpServers": { "服务名": { … } } } 配置；单个 url / command 配置请使用「新增 MCP」')
  if (JSON.stringify(input).includes('{{DSH_MCP_SAVED:')) throw Error('导入新服务需要实际凭据，不能使用其他服务编辑页中的已保存值占位符')
  const entries = Object.entries(record(input.mcpServers, 'mcpServers'))
  if (!entries.length || entries.length > 30) throw Error('一次导入 1–30 个 MCP 服务')
  return entries.map(([name, config]) => ({ name: requiredText(name, '名称', 80), config: parseMcpConfig(config) }))
}
