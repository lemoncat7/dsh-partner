// Real editor, styles and API adapter; isolated fixtures, no local user data writes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const initial = { id: 'fixture', name: '测试伙伴', role: '研究', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1 }
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
  import React, {useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {CapabilityEditor} from './src/ui/capability-editor';
  function Fixture() {
    const [companion,setCompanion] = useState(${JSON.stringify(initial)});
    window.switchCompanion = () => setCompanion({...companion,id:'other',capabilities:[]});
    const refresh = async () => {
      if(window.failRefresh) throw new Error('refresh failed');
      const response = await fetch('/fixture/snapshot');
      setCompanion(await response.json());
    };
    return <main className="dsh-partner-workspace"><div className="dsh-partner-content"><CapabilityEditor key={companion.id} companion={companion} presets={[]} onChanged={refresh}/></div></main>
  }
  createRoot(document.getElementById('app')).render(<Fixture/>);
` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', target: 'es2022', loader: {'.css': 'text', '.module.css': 'text'} })
const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/responsive-ui.css'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))).join('\n')
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/app.js' ? bundle.outputFiles[0].contents : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{background:#eceff1}body[data-ds-dark-theme]{background:#202427}</style><div id="app"></div><script src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({headless: true, args: ['--no-sandbox']})
try {
  const page = await browser.newPage({reducedMotion: 'reduce'})
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let saved = initial
  let writes = 0
  let receivePut
  await page.route('**/partner-local/v1/**', async route => {
    if (route.request().method() === 'PUT') { writes++; receivePut(route); return }
    const url = route.request().url()
    const body = url.endsWith('/models') ? {defaultSelection: {provider: 'local', model: 'default'}, providers: []}
      : url.endsWith('/access') ? {targetIds: [], companions: []} : {skills: [], bindings: []}
    await route.fulfill({json: body})
  })
  await page.route('**/fixture/snapshot', route => route.fulfill({json: saved}))
  const saveButton = page.locator('.is-capability-save > button')
  const status = page.locator('.is-capability-save [role=status]')
  const choice = page.getByRole('button', {name: /^伙伴管理（高权限）/})
  const startSave = async () => {
    const next = new Promise(resolve => { receivePut = resolve })
    await saveButton.evaluate(button => { button.click(); button.click() })
    const route = await next
    assert.equal(await saveButton.isDisabled(), true)
    assert.equal(await saveButton.textContent(), '正在保存…')
    assert.equal(await choice.isDisabled(), true)
    return route
  }
  const commit = async route => {
    saved = {...saved, ...route.request().postDataJSON().companion, updatedAt: saved.updatedAt + 1}
    await route.fulfill({json: saved})
    await page.waitForFunction(() => !document.querySelector('.is-capability-save > button').disabled)
    assert.match(await status.textContent(), /已保存，下一轮生效/)
  }
  for (const dark of [false, true]) for (const width of [375, 844, 1280]) {
    saved = initial
    await page.setViewportSize({width, height: width === 844 ? 390 : 844})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addStyleTag({content: styles})
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    await choice.click()
    const before = writes
    await commit(await startSave())
    assert.equal(writes, before + 1, 'double click writes once')
    assert.equal(await choice.getAttribute('aria-pressed'), 'true')
    const box = await status.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'save feedback fits the viewport')
    assert.equal(await status.locator('svg').count(), 1)
    await choice.click()
    assert.equal(await status.textContent(), '', 'editing clears stale success')
    const failed = await startSave()
    await failed.fulfill({status: 500, json: {error: '测试写入失败'}})
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /保存失败.*当前选择已保留/)
    assert.equal(await choice.getAttribute('aria-pressed'), 'false')
    await page.evaluate(() => window.failRefresh = true)
    await commit(await startSave())
    assert.match(await page.getByRole('alert').innerText(), /能力已保存.*无需重复应用/)
    await saveButton.scrollIntoViewIfNeeded()
    await page.screenshot({path: `/tmp/partner-capability-feedback-${width}-${dark ? 'dark' : 'light'}.png`})
  }
  const pending = await startSave()
  await page.evaluate(() => window.switchCompanion())
  await pending.fulfill({json: saved})
  await page.waitForFunction(() => !document.querySelector('.is-capability-save > button').disabled)
  assert.equal(await status.textContent(), '', 'old request cannot mark another companion saved')
  assert.deepEqual(errors, [])
  console.log('Capability editor: saving, duplicate prevention, saved, failed, refresh warning, companion switch; 6 responsive/theme cases passed.')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
