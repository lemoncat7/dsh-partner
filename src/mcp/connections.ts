import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpConfig } from './domain.js'
import { mcpConnectionError } from './connection-error.js'

interface Entry { client: Client; ready: Promise<void>; users: number; retired?: boolean; idle?: ReturnType<typeof setTimeout> }

/** Shares connections, not authorization. Idle processes are released; calls are never replayed. */
export class McpConnections {
  private readonly entries = new Map<string, Entry>()
  private readonly live = new Set<Entry>()
  private readonly shutdown = new AbortController()

  async use<T>(id: string, config: McpConfig, signal: AbortSignal, work: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.shutdown.signal])
    combined.throwIfAborted()
    let entry = this.entries.get(id)
    if (!entry) {
      const client = new Client({ name: 'dsh-partner', version: '1.0.0' })
      const transport = config.transport === 'stdio'
        ? new StdioClientTransport({ command: config.command!, args: config.args ?? [], env: config.env ?? {}, ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'pipe' })
        : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers ?? {}, redirect: 'error' } })
      const created: Entry = { client, users: 0, ready: Promise.resolve() }
      // Drain stderr to avoid blocking child processes; never persist or expose raw logs.
      let diagnostic = ''
      let connecting = true
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (chunk: Buffer) => {
        if (connecting) diagnostic = (diagnostic + chunk.toString()).slice(-16_384)
      })
      this.live.add(created)
      // SDK HTTP transport declares sessionId as string | undefined, unlike its
      // own optional Transport member under exactOptionalPropertyTypes.
      created.ready = client.connect(transport as Transport, { signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)]), timeout: 30_000 }).catch(async (error: unknown) => {
        if (this.entries.get(id) === created) this.entries.delete(id)
        await client.close().catch(() => {})
        this.live.delete(created)
        throw mcpConnectionError(error, diagnostic)
      }).finally(() => { connecting = false; diagnostic = '' })
      client.onclose = () => { if (this.entries.get(id) === created) this.entries.delete(id); this.live.delete(created) }
      this.entries.set(id, created)
      entry = created
    }
    if (entry.idle) clearTimeout(entry.idle)
    entry.users++
    try { await entry.ready; combined.throwIfAborted(); return await work(entry.client, combined) }
    catch (error) {
      // A server restart may invalidate an HTTP session without closing its
      // transport. The next operation reconnects; this operation is not replayed.
      if (this.entries.get(id) === entry) this.entries.delete(id)
      entry.retired = true
      throw error
    }
    finally {
      entry.users--
      const current = entry
      if (!current.users && current.retired) { await current.client.close().catch(() => {}); this.live.delete(current) }
      if (!current.users && this.entries.get(id) === current) {
        current.idle = setTimeout(() => {
          if (this.entries.get(id) !== current || current.users) return
          this.entries.delete(id)
          this.live.delete(current)
          void current.client.close().catch(() => {})
        }, 60_000)
        current.idle.unref()
      }
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort()
    const entries = [...this.live]
    this.entries.clear()
    this.live.clear()
    await Promise.all(entries.map(async entry => {
      if (entry.idle) clearTimeout(entry.idle)
      await entry.ready.catch(() => {})
      await entry.client.close().catch(() => {})
    }))
  }
}
