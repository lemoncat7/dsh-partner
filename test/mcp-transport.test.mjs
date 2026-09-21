import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpConnections } from '../lib/mcp/connections.js'

test('real stdio MCP discovery, call and disposal', async () => {
  const pool = new McpConnections()
  try {
    const config = { transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] }
    await pool.use('stdio', config, AbortSignal.timeout(10000), async (client, signal) => {
      assert.equal((await client.listTools({}, { signal })).tools[0].name, 'echo')
      const result = await client.callTool({ name: 'echo', arguments: { text: 'stdio ready' } }, undefined, { signal })
      assert.equal(result.content[0].text, 'stdio ready')
    })
  } finally { await pool.close() }
})

test('real Streamable HTTP uses configured auth and discovers refreshed tools without replaying calls', async t => {
  const resources = new Set(), requests = []
  let toolNames = ['echo'], calls = 0
  const http = createServer(async (req, res) => {
    requests.push(req.headers.authorization)
    if (req.headers.authorization !== 'Bearer fixture-secret') { res.writeHead(401).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    resources.add(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolNames.map(name => ({ name, inputSchema: { type: 'object' } })) }))
    server.setRequestHandler(CallToolRequestSchema, async () => { calls++; return { content: [{ type: 'text', text: 'http ready' }] } })
    res.on('close', () => { resources.delete(server); void server.close() })
    try { await server.connect(transport); await transport.handleRequest(req, res) }
    catch { if (!res.headersSent) res.writeHead(500).end() }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const pool = new McpConnections()
  t.after(async () => { await pool.close(); await Promise.all([...resources].map(s => s.close())); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)) })
  const config = { transport: 'streamable-http', url: `http://127.0.0.1:${http.address().port}/mcp`, headers: { Authorization: 'Bearer fixture-secret' } }
  let firstClient
  await pool.use('http', config, AbortSignal.timeout(10000), async (client, signal) => {
    firstClient = client
    assert.equal((await client.listTools({}, { signal })).tools.length, 1)
    assert.equal((await client.callTool({ name: 'echo' }, undefined, { signal })).content[0].text, 'http ready')
  })
  toolNames = ['echo', 'new_tool']
  await pool.use('http', config, AbortSignal.timeout(10000), async (client, signal) => {
    assert.equal(client, firstClient, 'reuse the idle connection')
    assert.equal((await client.listTools({}, { signal })).tools.length, 2)
  })
  assert.equal(calls, 1)
  assert.ok(requests.every(auth => auth === 'Bearer fixture-secret'))
  await assert.rejects(pool.use('http', config, AbortSignal.timeout(10000), async () => { throw Error('lost HTTP session') }), /lost HTTP session/)
  await pool.use('http', config, AbortSignal.timeout(10000), async (client, signal) => {
    assert.notEqual(client, firstClient, 'failure retires connection; next action reconnects')
    assert.equal((await client.listTools({}, { signal })).tools.length, 2)
  })
  assert.equal(calls, 1, 'recovery does not replay business calls')
})
