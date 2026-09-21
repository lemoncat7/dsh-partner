import { createHash, randomUUID } from 'node:crypto'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../store.js'
import { record, requiredText } from '../core/validation.js'
import { parseMcpConfig, parseMcpImport } from './config.js'
import { McpConnections } from './connections.js'
import { editableMcpConfig, restoreMcpConfig } from './edit-config.js'
import { createMcpCredentialId, type McpCredentials } from './credentials.js'
import type { McpCatalog, McpConfig, McpServer, McpTool } from './domain.js'

export class McpService {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: PartnerStore, private readonly vault: McpCredentials, private readonly connections = new McpConnections()) {}
  catalog(): McpCatalog {
    const state = this.store.snapshot()
    return { servers: (state.mcpServers ?? []).map(({ credentialId: _secret, ...server }) => server), bindings: state.mcpBindings ?? [] }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const job = this.writes.then(work, work)
    this.writes = job.catch(() => {})
    return job
  }
  private server(id: string): McpServer {
    const server = this.store.snapshot().mcpServers?.find(item => item.id === id)
    if (!server) throw Error('MCP 服务不存在，请刷新列表')
    return server
  }
  async save(input: unknown, id?: string): Promise<void> {
    const body = record(input)
    const name = requiredText(body.name, '名称', 80)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw Error('enabled 必须是布尔值')
    await this.serial(async () => {
      const previous = id ? this.server(id) : undefined
      if (body.expectedRevision !== undefined && body.expectedRevision !== previous?.revision) throw Error('MCP 配置已被修改，请重新打开编辑后保存，避免覆盖其他修改')
      const oldConfig = previous && body.config !== undefined ? await this.vault.read(previous.credentialId) : undefined
      const parsed = body.config === undefined ? undefined : parseMcpConfig(restoreMcpConfig(body.config, oldConfig))
      const config = parsed && JSON.stringify(parsed) !== JSON.stringify(oldConfig) ? parsed : undefined
      if (!previous && !config) throw Error('请填写 MCP 配置')
      const credentialId = config ? createMcpCredentialId() : previous!.credentialId
      if (config) await this.vault.write(credentialId, config)
      try {
        await this.store.update(state => {
          const servers = state.mcpServers ??= []
          if (servers.some(item => item.id !== id && item.name === name)) throw Error('MCP 名称已存在')
          if (!previous && servers.length >= 50) throw Error('最多配置 50 个 MCP 服务')
          const server: McpServer = {
            id: previous?.id ?? randomUUID(), name, transport: config?.transport ?? previous!.transport,
            enabled: typeof body.enabled === 'boolean' ? body.enabled : previous?.enabled ?? true,
            credentialId, revision: (previous?.revision ?? 0) + 1, tools: config ? [] : previous!.tools,
            updatedAt: Date.now(), ...(!config && previous?.refreshedAt ? { refreshedAt: previous.refreshedAt } : {}),
          }
          state.mcpServers = [...servers.filter(item => item.id !== server.id), server]
        })
      } catch (error) { if (config) await this.vault.delete(credentialId).catch(() => {}); throw error }
      if (config && previous) await this.vault.delete(previous.credentialId).catch(() => {})
    })
  }
  async edit(id: string, reveal = false) {
    const server = this.server(id)
    const config = await this.vault.read(server.credentialId)
    return { name: server.name, revision: server.revision, config: reveal ? config : editableMcpConfig(config) }
  }
  async import(value: unknown): Promise<void> {
    const entries = parseMcpImport(value)
    await this.serial(async () => {
      const existing = this.store.snapshot().mcpServers ?? []
      if (entries.length + existing.length > 50 || entries.some(entry => existing.some(server => server.name === entry.name))) throw Error('存在重名服务或超过 50 个服务，请修改后重试；没有导入任何配置')
      const credentials: string[] = []
      try {
        const servers: McpServer[] = []
        for (const entry of entries) {
          const credentialId = createMcpCredentialId(); credentials.push(credentialId)
          await this.vault.write(credentialId, entry.config)
          servers.push({ id: randomUUID(), name: entry.name, transport: entry.config.transport, enabled: true, credentialId, revision: 1, tools: [], updatedAt: Date.now() })
        }
        await this.store.update(state => { (state.mcpServers ??= []).push(...servers) })
      } catch (error) { await Promise.all(credentials.map(id => this.vault.delete(id).catch(() => {}))); throw error }
    })
  }
  async remove(id: string): Promise<void> {
    await this.serial(async () => {
      const server = this.server(id)
      await this.store.update(state => {
        state.mcpServers = (state.mcpServers ?? []).filter(item => item.id !== id)
        state.mcpBindings = (state.mcpBindings ?? []).filter(item => item.serverId !== id)
      })
      await this.vault.delete(server.credentialId).catch(() => {})
    })
  }
  async bind(companionId: string, serverId: string, enabled: boolean): Promise<void> {
    await this.store.update(state => {
      if (!state.companions.some(c => c.id === companionId) || this.store.isCompanionRemoving(companionId)) throw Error('伙伴不存在或正在删除')
      if (!state.mcpServers?.some(s => s.id === serverId)) throw Error('MCP 服务不存在')
      state.mcpBindings = (state.mcpBindings ?? []).filter(b => b.companionId !== companionId || b.serverId !== serverId)
      if (enabled) state.mcpBindings.push({ companionId, serverId })
    })
  }
  async refresh(id: string): Promise<void> {
    const server = this.server(id)
    try {
      const config = await this.vault.read(server.credentialId)
      const tools = await this.discover(server.credentialId, config)
      await this.store.update(state => {
        const current = state.mcpServers?.find(s => s.id === id)
        if (!current || current.credentialId !== server.credentialId || current.revision !== server.revision) throw Error('MCP 配置已变化，请重新刷新工具')
        current.tools = tools; current.revision++; current.refreshedAt = Date.now(); current.updatedAt = Date.now(); delete current.error
      })
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('MCP ') ? error.message : 'MCP 工具刷新失败，请检查连接、认证和服务日志后重试'
      await this.store.update(state => {
        const current = state.mcpServers?.find(s => s.id === id)
        if (current?.revision === server.revision && current.credentialId === server.credentialId) current.error = message
      })
      throw Error(message)
    }
  }
  private discover(id: string, config: McpConfig): Promise<McpTool[]> {
    return this.connections.use(id, config, AbortSignal.timeout(30_000), async (client, signal) => {
      const tools: McpTool[] = [], cursors = new Set<string>(), names = new Set<string>()
      let cursor: string | undefined
      do {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 30_000 })
        for (const tool of result.tools) {
          if (!tool.name || names.has(tool.name)) throw Error('MCP 工具名称为空或重复')
          names.add(tool.name)
          tools.push({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema })
        }
        if (tools.length > 200 || JSON.stringify(tools).length > 512_000) throw Error('MCP 工具目录过大（最多 200 项 / 512 KB）')
        cursor = result.nextCursor
        if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw Error('MCP 工具目录分页异常')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      return tools.sort((a, b) => a.name.localeCompare(b.name))
    })
  }
  definitions(companionId: string): ToolDefinition[] {
    const state = this.store.snapshot()
    if (!state.companions.find(c => c.id === companionId)?.capabilities.includes('mcp')) return []
    const ids = new Set(state.mcpBindings?.filter(b => b.companionId === companionId).map(b => b.serverId))
    return (state.mcpServers ?? []).filter(s => s.enabled && ids.has(s.id)).flatMap(server => server.tools.map(tool => ({
      name: mcpToolName(server.id, tool.name), description: `[${server.name}] ${tool.description ?? tool.name}`,
      parameters: tool.inputSchema,
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
      presentCall: () => ({ card: 'generic' as const, title: `${server.name} · ${tool.name}` }),
      execute: async (args, execution) => {
        this.authorize(companionId, server, tool.name)
        const config = await this.vault.read(server.credentialId)
        return this.connections.use(server.credentialId, config, execution.signal, async (client, signal) => {
          this.authorize(companionId, server, tool.name)
          const parameters = record(args, 'MCP 参数')
          const rawResult = await client.callTool({ name: tool.name, arguments: parameters }, undefined, { signal, timeout: 60_000 }).catch(() => {
            signal.throwIfAborted()
            // Transport diagnostics can contain URLs, headers or subprocess args.
            // Do not replay a potentially side-effecting tool call on failure.
            throw Error('MCP 调用未成功返回，请检查服务连接或认证；未自动重试，请先确认远端执行结果')
          })
          const result = CallToolResultSchema.parse(rawResult)
          const content = result.content.map(block => {
            if (block.type === 'text' || block.type === 'resource_link') return block
            if (block.type === 'resource' && typeof block.resource === 'object' && block.resource !== null && 'text' in block.resource) return block
            return { type: 'text', text: `MCP 返回 ${block.type} 内容；此处不直接传送二进制，请使用服务的资源下载工具获取文件地址。` }
          })
          const text = JSON.stringify({ content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}), ...(result.isError ? { isError: true } : {}) })
          if (text.length > 256_000) throw Error('MCP 返回内容过大，请缩小查询或请求文件下载地址')
          if (result.isError) throw Error(text)
          return text
        })
      },
    })))
  }
  private authorize(companionId: string, snapshot: McpServer, name: string): void {
    const state = this.store.snapshot(), current = state.mcpServers?.find(s => s.id === snapshot.id)
    if (this.store.isCompanionRemoving(companionId) || !this.store.hasCapability(companionId, 'mcp') || !state.mcpBindings?.some(b => b.companionId === companionId && b.serverId === snapshot.id) || !current?.enabled) throw Error('MCP 授权已撤回，未执行调用')
    const tool = current.tools.find(t => t.name === name), previous = snapshot.tools.find(t => t.name === name)
    if (current.credentialId !== snapshot.credentialId || !tool || JSON.stringify(tool.inputSchema) !== JSON.stringify(previous?.inputSchema)) throw Error('MCP 配置或工具已变更，请下一轮对话重试')
  }
  async close(): Promise<void> { await this.writes; await this.connections.close() }
}

export function mcpToolName(serverId: string, name: string): string {
  const hash = createHash('sha256').update(`${serverId}\0${name}`).digest('hex').slice(0, 16)
  return `mcp__${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}_${hash}`
}
