import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { McpService, mcpToolName } from '../lib/mcp/service.js'
import { parseMcpConfig, parseMcpImport } from '../lib/mcp/config.js'
import { SessionConfigurationIndex } from '../lib/companions/session-configuration.js'
import { McpCredentials, createMcpCredentialId } from '../lib/mcp/credentials.js'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'partner-mcp-'))
  const store = await PartnerStore.open(join(dir, 'state.json'))
  const secrets = new Map()
  const vault = new McpCredentials({
    readRecord: async key => secrets.get(key),
    modifyRecord: async (key, modify) => secrets.set(key, await modify(secrets.get(key))),
    deleteRecord: async key => secrets.delete(key),
  })
  const state = { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], fail: false, calls: 0 }
  const pool = { async use(id, config, signal, work) { signal.throwIfAborted(); if (state.fail) throw Error('secret in transport error'); return work({ listTools: async () => ({ tools: structuredClone(state.tools) }), callTool: async () => { state.calls++; return { content: [{ type: 'text', text: 'done' }] } } }, signal) }, async close() {} }
  const mcp = new McpService(store, vault, pool)
  const companionId = store.snapshot().companions[0].id
  await store.update(s => { s.companions[0].capabilities = ['mcp']; s.sessions.push({ id: 'r', kind: 'local', channelId: '@local', userId: companionId, companionId, sessionId: 's', lastMessageAt: 1 }) })
  t.after(async () => { await mcp.close(); await rm(dir, { recursive: true, force: true }) })
  return { store, vault, secrets, mcp, state, companionId, dir }
}

test('new MCP credential IDs always satisfy the real vault key rules', () => {
  for (let n = 0; n < 100; n++) {
    const id = createMcpCredentialId()
    assert.match(id, /^mcp-[0-9a-f-]+$/)
    assert.doesNotThrow(() => credentialKey('dsh-partner-mcp', id))
  }
})

test('legacy credentials remain readable and unchanged until config replacement', async t => {
  const { mcp, store, vault, secrets } = await fixture(t)
  const legacyId = 'a4ca1fa8-1b9a-4b89-b8b2-5293a3dd42e0'
  await vault.write(legacyId, parseMcpConfig({ command: 'node' }))
  await store.update(s => { s.mcpServers = [{ id: 'legacy-server', name: 'Legacy', transport: 'stdio', enabled: true, credentialId: legacyId, revision: 1, tools: [], updatedAt: 1 }] })
  const edit = await mcp.edit('legacy-server')
  assert.equal(edit.config.command, 'node')
  await mcp.save({ name: 'Renamed', config: edit.config }, 'legacy-server')
  assert.equal(store.snapshot().mcpServers[0].credentialId, legacyId)
  await mcp.save({ name: 'Renamed', config: { command: 'updated' } }, 'legacy-server')
  assert.match(store.snapshot().mcpServers[0].credentialId, /^mcp-/)
  assert.equal(secrets.has(credentialKey('dsh-partner-mcp', legacyId)), false)
  assert.equal((await mcp.edit('legacy-server', true)).config.command, 'updated')
  await mcp.remove('legacy-server')
  assert.equal(secrets.size, 0)
})

test('MCP configuration import accepts HTTP and stdio, rejects unsupported transports', () => {
  const values = parseMcpImport({ mcpServers: { viora: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private' } }, local: { command: 'node', args: ['server.mjs'] } } })
  assert.equal(values[0].config.transport, 'streamable-http')
  assert.equal(values[1].config.transport, 'stdio')
  assert.throws(() => parseMcpConfig({ url: 'file:///private' }))
  assert.throws(() => parseMcpConfig({ type: 'sse', url: 'https://example.com/sse' }))
  assert.throws(() => parseMcpConfig({ command: 'node', args: [1] }))
  assert.throws(() => parseMcpConfig({ url: 'https://example.com', headers: { Authorization: 3 } }))
  assert.match(mcpToolName('id', '中文 tool / long '.repeat(50)), /^[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(mcpToolName('one', 'echo'), mcpToolName('two', 'echo'))
  assert.equal(parseMcpConfig({ mcpServers: { docmost: { command: 'npx', args: ['-y', 'mcp-remote', 'http://docmost:3000/mcp'] } } }).command, 'npx')
  assert.throws(() => parseMcpConfig({ mcpServers: { a: { command: 'node' }, b: { command: 'node' } } }), /多个服务请使用/)
  assert.throws(() => parseMcpImport({ command: 'npx' }), /导入 JSON 需要完整/)
  assert.throws(() => parseMcpConfig({}), /包含 url.*包含 command/)
})

test('editing prefills config with masked credentials; unchanged save keeps tools and secrets', async t => {
  const { mcp, vault, store, companionId } = await fixture(t)
  await mcp.save({ name: 'Docmost', config: { command: 'npx', args: ['-y', 'mcp-remote', 'http://docmost:3000/mcp', '--header', 'Authorization: Bearer example-secret'], env: { TOKEN: 'private-env' } } })
  const id = mcp.catalog().servers[0].id
  await mcp.refresh(id); await mcp.bind(companionId, id, true)
  const before = store.snapshot().mcpServers[0]
  const edit = await mcp.edit(id)
  assert.equal(edit.config.command, 'npx')
  assert.equal(edit.config.args.length, 5)
  assert.ok(!JSON.stringify(edit).includes('example-secret'))
  assert.ok(!JSON.stringify(edit).includes('private-env'))
  const revealed = await mcp.edit(id, true)
  assert.match(revealed.config.args[4], /example-secret/)
  await mcp.save({ name: 'Updated', config: edit.config, expectedRevision: edit.revision }, id)
  const after = store.snapshot().mcpServers[0]
  assert.equal(after.credentialId, before.credentialId)
  assert.equal(after.tools.length, 1)
  assert.equal((await vault.read(after.credentialId)).env.TOKEN, 'private-env')
  await assert.rejects(mcp.save({ name: 'Stale', config: edit.config, expectedRevision: edit.revision }, id), /重新打开编辑/)
  const next = await mcp.edit(id)
  next.config.env.TOKEN = 'replacement'
  await mcp.save({ name: 'Updated', config: next.config, expectedRevision: next.revision }, id)
  assert.equal((await mcp.edit(id, true)).config.env.TOKEN, 'replacement')
  assert.equal(mcp.catalog().servers[0].tools.length, 0)
})

test('HTTP edit masks authorization and URL query; placeholders cannot be imported or moved', async t => {
  const { mcp } = await fixture(t)
  await mcp.save({ name: 'HTTP', config: { url: 'https://example.com/mcp?token=secret', headers: { Authorization: 'Bearer secret' } } })
  const id = mcp.catalog().servers[0].id, edit = await mcp.edit(id)
  assert.ok(!JSON.stringify(edit).includes('Bearer secret'))
  assert.ok(!JSON.stringify(edit).includes('token=secret'))
  await assert.rejects(mcp.save({ name: 'Copied', config: edit.config }), /占位符无效/)
  await assert.rejects(mcp.import({ mcpServers: { copied: edit.config } }), /需要实际凭据/)
  const moved = structuredClone(edit.config)
  moved.headers.Other = moved.headers.Authorization
  await assert.rejects(mcp.save({ name: 'HTTP', config: moved, expectedRevision: edit.revision }, id), /占位符无效/)
  edit.config.url = 'https://example.com/new'
  await mcp.save({ name: 'HTTP', config: edit.config, expectedRevision: edit.revision }, id)
  assert.equal((await mcp.edit(id, true)).config.headers.Authorization, 'Bearer secret')
})

test('grant, tool refresh and revoke change the next-turn revision, not the current definitions', async t => {
  const { store, mcp, state, companionId } = await fixture(t)
  const index = new SessionConfigurationIndex(store); t.after(() => index.close())
  await mcp.save({ name: 'Test', config: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private' } } })
  const server = mcp.catalog().servers[0]
  await mcp.refresh(server.id)
  assert.deepEqual(mcp.definitions(companionId), [])
  const before = index.forSession('s').revision
  await mcp.bind(companionId, server.id, true)
  assert.notEqual(index.forSession('s').revision, before)
  const old = mcp.definitions(companionId)
  assert.equal(old.length, 1)
  const revision = index.forSession('s').revision
  state.tools.push({ name: 'new_tool', inputSchema: { type: 'object' } })
  await mcp.refresh(server.id)
  assert.notEqual(index.forSession('s').revision, revision)
  assert.equal(old.length, 1)
  assert.equal(mcp.definitions(companionId).length, 2)
  assert.match(await old[0].execute({}, { signal: new AbortController().signal }), /done/)
  await mcp.bind(companionId, server.id, false)
  await assert.rejects(old[0].execute({}, { signal: new AbortController().signal }), /撤回/)
  assert.equal(state.calls, 1)
  assert.deepEqual(mcp.definitions(companionId), [])
  assert.ok(!JSON.stringify(store.snapshot()).includes('Bearer private'))
  assert.ok(!JSON.stringify(mcp.catalog()).includes('credentialId'))
})

test('refresh failure keeps last good catalog, retry persists new tools across restart', async t => {
  const { mcp, state, dir, companionId } = await fixture(t)
  await mcp.save({ name: 'Test', config: { command: 'node' } })
  const id = mcp.catalog().servers[0].id
  await mcp.refresh(id); await mcp.bind(companionId, id, true)
  const revision = mcp.catalog().servers[0].revision
  state.fail = true
  await assert.rejects(mcp.refresh(id), /刷新失败/)
  assert.equal(mcp.catalog().servers[0].revision, revision)
  assert.equal(mcp.catalog().servers[0].tools.length, 1)
  assert.ok(!mcp.catalog().servers[0].error.includes('secret'))
  state.fail = false; state.tools = [{ name: 'replacement', inputSchema: { type: 'object' } }]
  await mcp.refresh(id)
  assert.equal(mcp.catalog().servers[0].error, undefined)
  const restored = await PartnerStore.open(join(dir, 'state.json'))
  assert.equal(restored.snapshot().mcpServers[0].tools[0].name, 'replacement')
  assert.equal(restored.snapshot().mcpBindings.length, 1)
})

test('configuration replacement and removed tools block stale execution; deletion cleans bindings', async t => {
  const { mcp, companionId, state, secrets } = await fixture(t)
  await mcp.save({ name: 'Test', config: { command: 'node' } })
  const id = mcp.catalog().servers[0].id
  await mcp.refresh(id); await mcp.bind(companionId, id, true)
  const old = mcp.definitions(companionId)[0]
  state.tools = []; await mcp.refresh(id)
  await assert.rejects(old.execute({}, { signal: new AbortController().signal }), /变更/)
  await mcp.save({ name: 'Test', config: { command: 'other' } }, id)
  assert.equal(secrets.size, 1)
  await assert.rejects(old.execute({}, { signal: new AbortController().signal }), /变更/)
  await mcp.remove(id)
  assert.deepEqual(mcp.catalog(), { servers: [], bindings: [] })
  assert.equal(secrets.size, 0)
})

test('import is atomic on duplicate names or credential write failure', async t => {
  const { mcp, secrets, vault } = await fixture(t)
  await mcp.import({ mcpServers: { a: { command: 'node' }, b: { url: 'https://example.com' } } })
  await assert.rejects(mcp.import({ mcpServers: { a: { command: 'node' }, c: { command: 'node' } } }), /重名/)
  assert.equal(mcp.catalog().servers.length, 2)
  let n = 0; const write = vault.write.bind(vault)
  vault.write = async (...args) => { if (++n === 2) throw Error('storage failure'); await write(...args) }
  await assert.rejects(mcp.import({ mcpServers: { d: { command: 'node' }, e: { command: 'node' } } }), /storage failure/)
  assert.equal(mcp.catalog().servers.length, 2)
  assert.equal(secrets.size, 2)
})

test('parameter changes reject stale definitions and expose new schema on recomposition', async t => {
  const { mcp, state, companionId } = await fixture(t)
  await mcp.save({ name: 'Test', config: { command: 'node' } })
  const id = mcp.catalog().servers[0].id
  await mcp.refresh(id); await mcp.bind(companionId, id, true)
  const old = mcp.definitions(companionId)[0]
  state.tools[0].inputSchema = { type: 'object', properties: { updated: { type: 'boolean' } } }
  await mcp.refresh(id)
  await assert.rejects(old.execute({}, { signal: new AbortController().signal }), /变更/)
  assert.ok(mcp.definitions(companionId)[0].parameters.properties.updated)
})

test('refresh in flight cannot overwrite a replacement configuration', async t => {
  const { store, vault, companionId } = await fixture(t)
  let release, entered
  const barrier = new Promise(resolve => { release = resolve }), start = new Promise(resolve => { entered = resolve })
  const service = new McpService(store, vault, { async use(_id, _config, signal, work) { entered(); await barrier; return work({ listTools: async () => ({ tools: [{ name: 'old', inputSchema: { type: 'object' } }] }) }, signal) }, async close() {} })
  await service.save({ name: 'Test', config: { command: 'node' } })
  const id = service.catalog().servers[0].id
  const pending = service.refresh(id)
  await start
  await service.save({ name: 'Test', config: { command: 'new-command' } }, id)
  const rejected = assert.rejects(pending, /配置已变化/)
  release(); await rejected
  assert.deepEqual(service.catalog().servers[0].tools, [])
  assert.equal(service.catalog().servers[0].error, undefined)
  await service.bind(companionId, id, true)
  assert.deepEqual(service.definitions(companionId), [])
})
