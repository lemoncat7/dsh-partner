// Isolated UI fixture: no user profiles, credentials or external MCP calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {McpPanel} from './src/ui/mcp-panel'; import {CompanionMcpSettings} from './src/ui/mcp-capabilities'; createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><div className="dsh-partner-content">{location.hash === '#bindings' ? <CompanionMcpSettings companionId="one" /> : <McpPanel />}</div></main>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', loader: { '.css': 'text', '.module.css': 'text' } })
const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/responsive-ui.css', 'src/ui/form-surface.css', 'src/ui/mcp.css'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))).join('\n')
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="app"></div><script src="/app.js"></script>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  let catalog, submitted, fail
  await page.route('**/partner-local/v1/mcp**', async route => {
    const request = route.request()
    if (request.method() === 'GET' && request.url().includes('/config')) {
      await route.fulfill({ json: { name: 'Viora 测试服务', revision: 2, config: { transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: request.url().includes('reveal=1') ? 'Bearer fixture-token' : '{{DSH_MCP_SAVED:headers%2FAuthorization}}' } } } }); return
    }
    if (request.method() === 'PUT') submitted = request.postDataJSON()
    if (request.method() === 'POST') {
      submitted = request.postDataJSON()
      if (request.url().endsWith('/bindings')) catalog.bindings = submitted.enabled ? [{ companionId: 'one', serverId: submitted.serverId }] : []
      else if (fail) { await route.fulfill({ status: 400, json: { error: '测试：配置失败，请重试' } }); return }
    }
    await route.fulfill({ json: catalog })
  })
  for (const dark of [false, true]) for (const width of [375, 844, 1440]) {
    catalog = { servers: [{ id: 'test', name: 'Viora 测试服务', transport: 'streamable-http', enabled: true, revision: 2, updatedAt: 1, refreshedAt: Date.now(), tools: [{ name: 'viora_asset_get', description: '获取文件下载地址', inputSchema: { type: 'object' } }] }], bindings: [] }
    await page.setViewportSize({ width, height: width === 844 ? 390 : 900 })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addStyleTag({ content: styles })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    await page.getByRole('button', { name: '工具列表', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('button', { name: '新增 MCP', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('textbox', { name: '服务名称', exact: true }).fill('测试')
    await page.getByRole('textbox', { name: /^连接配置 JSON/ }).fill('{"type":"http","url":"https://example.com/mcp"}')
    fail = true
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('测试：配置失败，请重试', { exact: true }).waitFor()
    assert.equal(submitted.config.url, 'https://example.com/mcp')
    assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth), false)
    if (width === 375 && !dark) await page.screenshot({ path: '/tmp/partner-mcp-mobile.png' })
    await page.getByRole('button', { name: '取消', exact: true }).click()
    fail = false
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const config = page.getByRole('textbox', { name: /^连接配置 JSON/ })
    await page.waitForFunction(() => document.querySelector('dialog textarea')?.value.includes('https://example.com/mcp'))
    assert.ok((await config.inputValue()).includes('DSH_MCP_SAVED'))
    await page.getByRole('button', { name: '显示完整配置', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('dialog textarea')?.value.includes('Bearer fixture-token'))
    await page.getByRole('button', { name: '隐藏敏感值', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('dialog textarea')?.value.includes('DSH_MCP_SAVED'))
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(submitted.expectedRevision, 2)
    assert.ok(submitted.config.headers.Authorization.includes('DSH_MCP_SAVED'))
    await page.getByRole('button', { name: '工具列表', exact: true }).click()
    await page.getByText('viora_asset_get', { exact: true }).click()
    await page.getByText('获取文件下载地址', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.goto(`http://127.0.0.1:${server.address().port}/?fixture=bindings#bindings`)
    await page.addStyleTag({ content: styles })
    await page.getByRole('button', { name: '选择 MCP', exact: true }).click()
    await page.getByRole('button', { name: '授权', exact: true }).click()
    await page.getByText('已授权，下一轮对话生效，无需新建会话。', { exact: true }).waitFor()
    const action = page.getByRole('dialog').getByRole('button', { name: '移除授权', exact: true })
    const rect = await action.boundingBox()
    assert.ok(rect.width < 110 && rect.height <= 44, 'grant action stays compact')
    assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth), false)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '移除授权', exact: true }).click()
    await page.getByText('授权已移除，立即阻止新的调用，下一轮移除工具列表。', { exact: true }).waitFor()
  }
  assert.deepEqual(errors, [])
  console.log('MCP UI passed: light/dark, 375/844/1440, dialogs, inline errors, tool details, grant and revoke feedback')
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
