// Isolated fixture; never reads or updates actual companions.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {CapabilityEditor} from './src/ui/capability-editor';const companion={id:'fixture',name:'测试',role:'',description:'',instructions:'',capabilities:[],updatedAt:1};createRoot(document.getElementById('app')).render(<CapabilityEditor companion={companion} presets={[]} onChanged={async()=>{}}/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', loader: { '.css': 'text', '.module.css': 'text' } })
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<div id="app"></div><script src="/app.js"></script>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({reducedMotion:'reduce'})
  let fail = false, submitted, writes = 0
  await page.route('**/partner-local/v1/**', async route => {
    const req = route.request(), url = req.url()
    if (req.method() === 'PUT') {
      writes++; submitted = req.postDataJSON()
      await route.fulfill(fail ? { status: 400, json: { error: 'fixture save failure' } } : { json: {} }); return
    }
    await route.fulfill({ json: url.endsWith('/models') ? { defaultSelection: {}, providers: [] } : url.endsWith('/mcp') ? { servers: [], bindings: [] } : url.endsWith('/skills') ? { installed: [], bindings: [], sources: [] } : { targetIds: [], companions: [] } })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  assert.equal(await page.getByRole('button', { name: '应用能力组合' }).count(), 0)
  const mcp = page.getByRole('button', { name: /^MCP/ })
  await mcp.click()
  await page.getByRole('button', { name: '管理MCP 服务', exact: true }).waitFor()
  assert.deepEqual(submitted.companion.capabilities, ['mcp'])
  assert.equal(writes, 1)
  await page.getByText('已保存，下一轮生效', { exact: true }).waitFor()
  fail = true
  const ssh = page.getByRole('button', { name: /^SSH/ })
  await ssh.click()
  await page.getByText(/已恢复原选择/).waitFor()
  assert.equal(await ssh.getAttribute('aria-pressed'), 'false')
  assert.equal(await mcp.getAttribute('aria-pressed'), 'true')
  fail = false
  await ssh.click()
  await page.getByText('已保存，下一轮生效', { exact: true }).waitFor()
  assert.deepEqual(submitted.companion.capabilities, ['mcp', 'ssh'])
  await page.getByRole('button', { name: /^Skill/ }).click()
  await page.getByRole('button', { name: '管理Skill', exact: true }).waitFor()
  const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/responsive-ui.css', 'src/ui/form-surface.css', 'src/ui/mcp.css'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))).join('\n')
  await page.addStyleTag({ content: styles })
  await page.evaluate(() => { document.querySelector('#app').className = 'dsh-partner-workspace'; document.head.insertAdjacentHTML('beforeend', '<meta name="viewport" content="width=device-width,initial-scale=1">') })
  for (const dark of [false, true]) for (const width of [375, 844, 1440]) {
    await page.setViewportSize({width, height: width === 844 ? 390 : 900})
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    assert.equal(await page.locator('.dsh-partner-capability-save-status').evaluate(el => getComputedStyle(el).position), 'static', 'save feedback stays in normal flow instead of overlapping content')
    for (const name of ['管理Skill', '管理可访问伙伴', '管理MCP 服务']) {
      const trigger = page.getByRole('button', {name, exact:true})
      await trigger.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.equal(await trigger.evaluate(el => !!el.closest('.dsh-partner-capability-card')), true, 'management stays with its corresponding card')
      assert.equal(await dialog.count(), 1, 'never nest configuration dialogs')
      assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false)
      assert.ok((await dialog.boundingBox()).height <= page.viewportSize().height)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'resource dialog fits the viewport')
      if (width === 1440) assert.ok(bounds.width >= 1000, 'resource dialog uses available desktop space')
      if (width === 375 && !dark && name === '管理MCP 服务') await page.screenshot({path:'/tmp/partner-capability-dialog-mobile.png',animations:'disabled'})
      await page.keyboard.press('Escape')
      await dialog.waitFor({state:'hidden'})
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
    }
  }
  assert.equal(await page.locator('.dsh-partner-skill-installed').count(), 0, 'detailed lists are unmounted on the main page')
  await page.setViewportSize({width:1100,height:1000})
  await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
  await page.screenshot({path:'/tmp/partner-capability-cards.png',fullPage:true,animations:'disabled'})
  console.log('Capability autosave passed: immediate save, MCP details, rollback, retry, retained selections')
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
