import test from 'node:test'
import assert from 'node:assert/strict'
import { mcpConnectionError } from '../lib/mcp/connection-error.js'
import { McpConnections } from '../lib/mcp/connections.js'

test('connection diagnostics explain causes without disclosing raw stderr or secrets', () => {
  for (const [diagnostic, expected] of [
    ['Cannot find module iconv-lite MODULE_NOT_FOUND', /依赖缺失/],
    ['Non-HTTPS URLs are only allowed', /--allow-http/],
    ['401 Unauthorized', /认证失败/],
    ['spawn missing ENOENT', /命令或工作目录不存在/],
    ['EAI_AGAIN', /DNS/], ['ECONNREFUSED', /连接被拒绝/],
    ['Request timed out', /超时/], ['unknown failure', /握手/],
  ]) {
    const result = mcpConnectionError(Error(diagnostic), 'Authorization: Bearer secret-value').message
    assert.match(result, /^MCP /)
    assert.match(result, expected)
    assert.ok(!result.includes('secret-value'))
  }
})

test('real stdio startup dependency failure reaches callers with safe actionable message', async () => {
  const pool = new McpConnections()
  try {
    await assert.rejects(pool.use('broken', {
      transport: 'stdio', command: process.execPath,
      args: ['-e', 'console.error("Bearer secret-value"); require("missing-dsh-test-dependency")'],
    }, AbortSignal.timeout(5000), async () => assert.fail('must not connect')), error => {
      assert.match(error.message, /依赖缺失/)
      assert.ok(!error.message.includes('secret-value'))
      return true
    })
  } finally { await pool.close() }
})
