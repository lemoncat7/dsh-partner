// Isolated browser regression: real mobile controls/CSS, no partner API or data writes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const entry = await readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
const controls = entry.slice(entry.indexOf('function MobileWorkspaceControls('), entry.indexOf('\nfunction HomePanel('))
const result = await build({
  stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { IconPlusOutline16, IconBrowseOutline16, IconListPenOutline16, IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
    import { CompanionPicker } from './src/ui/companion-picker';
    ${controls}
    function Fixture() {
      const [selectedId, setSelectedId] = useState('0');
      const [view, setView] = useState('home');
      const companions = Array.from({length: 30}, (_, i) => ({ id: String(i), name: i === 0 ? '莫殇' : '伙伴' + i + '很长的名字测试', role: '负责项目资料整理与任务协作的伙伴' }));
      return <main className="dsh-partner-workspace"><header className="dsh-partner-topbar">
        <div className="dsh-partner-topbar-brand"><button data-xiaohei-workspace-close aria-label="返回会话">‹</button><span><strong>伙伴</strong><small>长期身份与微信渠道</small></span></div>
        <MobileWorkspaceControls companions={companions} selectedId={selectedId} view={view} openCompanion={setSelectedId} openPage={setView} createCompanion={() => {}} />
      </header><section><button id="outside">正文</button><output>{selectedId}</output></section></main>
    }
    createRoot(document.getElementById('app')).render(<Fixture />);
  `, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
})
const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/companion-picker.css', 'src/ui/responsive-ui.css'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))).join('\n')
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html')
  res.end(req.url === '/app.js' ? result.outputFiles[0].contents : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{margin:0;height:100%}body{background:#e5e7e9}body[data-ds-dark-theme]{background:#202427}</style><div id="app"></div><script src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.addStyleTag({ content: styles })
  // Simulate host theme rules loading after the plugin; the popup still owns its surface.
  await page.evaluate(() => document.body.id = 'root')
  await page.addStyleTag({ content: '#root [role="listbox"] { background: rgba(22,29,31,.88) !important; } #root [role="listbox"] [aria-selected="true"] { background: red; box-shadow: inset 3px 0 red; }' })
  const trigger = page.getByRole('button', { name: /^切换当前伙伴/ })
  for (const dark of [false, true]) {
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    for (const width of [320, 375, 430, 760, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 760 ? 390 : 844 })
      if (width > 760) { assert.equal(await trigger.isVisible(), false, 'desktop must not expose unstyled mobile controls'); continue }
      await trigger.click()
      const popup = page.getByRole('listbox')
      assert.equal(await popup.isVisible(), true)
      assert.equal(await popup.evaluate(node => getComputedStyle(node).backgroundColor), dark ? 'rgb(24, 32, 34)' : 'rgb(244, 244, 244)', 'theme must not make the menu transparent')
      const box = await popup.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y + box.height < (width === 760 ? 390 : 844), 'popup must fit viewport')
      assert.equal(await trigger.locator('.dsh-partner-companion-chevron').count(), 1)
      assert.equal(await trigger.evaluate(node => getComputedStyle(node).backgroundImage), 'none')
      assert.equal(await trigger.evaluate(node => getComputedStyle(node.parentElement, '::after').content), 'none')
      assert.ok((await trigger.boundingBox()).height >= 44)
      assert.ok((await page.locator('.dsh-partner-topbar').boundingBox()).height < 125, 'topbar stays within two compact rows')
      await page.keyboard.press('End')
      assert.equal(await page.locator(':focus').getAttribute('role'), 'option')
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('output').textContent(), '29')
      assert.equal(await popup.count(), 0)
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
      await trigger.press('ArrowDown')
      await page.keyboard.press('Home')
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('output').textContent(), '0')
      await trigger.click()
      await page.keyboard.press('Escape')
      assert.equal(await popup.count(), 0)
      await trigger.click()
      await page.keyboard.press('Tab')
      assert.equal(await popup.count(), 0, 'Tab dismisses without a focus trap')
      await trigger.click()
      await page.locator('#outside').click({ force: true })
      assert.equal(await popup.count(), 0)
      if (width === 375) {
        await trigger.click()
        await page.screenshot({ path: `/tmp/partner-picker-${dark ? 'dark' : 'light'}.png` })
        await page.keyboard.press('Escape')
      }
    }
  }
  await page.setViewportSize({ width: 375, height: 844 })
  await trigger.click()
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.waitForTimeout(50)
  assert.equal(await page.getByRole('listbox').count(), 0, 'rotation dismisses hidden popup')
  assert.deepEqual(errors, [])
  console.log('Partner picker: light/dark, 7 widths, overflow, keyboard and dismissal checks passed.')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
