// Isolated real form and API payload checks; never installs into a user profile.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SkillImportDialog} from './src/ui/skill-import-dialog'; createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><SkillImportDialog close={()=>{window.closedImport=true}} changed={()=>{window.changedImport=true}} /></main>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', loader: { '.css': 'text', '.module.css': 'text' } })
const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/responsive-ui.css'].map(path => readFile(join(root, path), 'utf8')))).join('\n')
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script src="/app.js"></script></body></html>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const fixture = await mkdtemp(join(tmpdir(), 'partner-import-ui-'))
await mkdir(join(fixture, '示例', 'references'), { recursive: true })
await writeFile(join(fixture, '示例', 'SKILL.md'), '# 测试')
await writeFile(join(fixture, '示例', 'references', 'guide.md'), '配套文件')
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  let submitted, reject = true
  await page.route('**/partner-local/v1/skills/import', async route => {
    submitted = route.request().postDataJSON()
    await route.fulfill({ status: reject ? 400 : 201, json: reject ? { error: '测试：没有找到 SKILL.md' } : { id: 'imported' } })
  })
  for (const width of [375, 844, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addStyleTag({ content: styles })
    await page.getByRole('dialog').waitFor()
    assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth), false)
    await page.locator('input[accept]').setInputFiles({ name: 'example.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') })
    await page.getByRole('button', { name: '导入 Skill', exact: true }).click()
    await page.getByText('测试：没有找到 SKILL.md', { exact: true }).waitFor()
    assert.equal(submitted.kind, 'zip')
    if (width === 375) await page.screenshot({ path: '/tmp/partner-skill-import-mobile.png' })
  }
  reject = false
  await page.locator('input[webkitdirectory]').setInputFiles(join(fixture, '示例'))
  await page.getByRole('button', { name: '导入 Skill', exact: true }).click()
  await page.waitForFunction(() => window.closedImport && window.changedImport)
  assert.equal(submitted.kind, 'directory')
  assert.ok(submitted.files.some(file => file.path.endsWith('references/guide.md')))
  assert.deepEqual(errors, [])
  console.log('Skill import UI passed: ZIP/directory payloads, visible errors, desktop/tablet/mobile')
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(fixture, { recursive: true, force: true }) }
