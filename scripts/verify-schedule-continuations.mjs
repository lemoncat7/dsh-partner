// Isolated fixture: no live jobs or channel messages are created.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {SchedulePanel} from './src/ui/schedule-panel';
createRoot(document.getElementById('app')).render(<main className="dsh-partner-workspace"><div className="dsh-partner-content"><SchedulePanel companions={[{id:'owner',name:'伙伴',capabilities:['schedules']},{id:'disabled',name:'未授权伙伴',capabilities:[]}]}/></div></main>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'text' } })
const css = (await Promise.all(['client.css', 'ui/workspace-ui.css', 'ui/responsive-ui.css', 'ui/form-surface.css'].map(name => readFile(new URL('../src/' + name, import.meta.url), 'utf8')))).join('\n')
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].contents : '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script src="/app.js"></script>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [375, 800, 1280]) for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    let entries = ['waiting', 'completed', 'blocked'].map((state, i) => ({ id: `wake-${i}`, companionId: 'owner', title: `视频任务 ${i}`, prompt: '按任务 ID 查询服务状态，不重复提交', schedule: { kind: 'once', at: Date.now() }, enabled: state === 'waiting', nextRunAt: Date.now(), destroySessionAfterRun: false, continuation: { state, externalTaskId: 'job-123', attempts: 2, maxAttempts: 12, deadlineAt: Date.now() + 3600_000, nextStep: '核实已下载文件，完成后给出路径。'.repeat(35) + 'https://example.test/' + 'long-id'.repeat(40), summary: '已查询状态' } }))
    entries.push({ ...entries[0], id: 'disabled', companionId: 'disabled', title: '能力已关闭的计划' })
    let lastRequest
    await page.route('**/partner-local/v1/schedules**', async route => {
      lastRequest = { method: route.request().method(), url: route.request().url() }
      if (lastRequest.method === 'PUT') entries[0].enabled = route.request().postDataJSON().enabled
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedules: entries, runs: [] }) })
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addStyleTag({ content: css })
    await page.evaluate(d => document.body.toggleAttribute('data-ds-dark-theme', d), dark)
    const cards = page.locator('.dsh-partner-schedule-list > article'); await cards.first().waitFor()
    assert.equal(await cards.count(), 4)
    assert.equal(await cards.nth(1).getByRole('button', { name: '立即检查' }).isDisabled(), true)
    assert.equal(await cards.nth(3).getByRole('button', { name: '立即检查' }).isDisabled(), true)
    await cards.first().locator('summary').click()
    assert.equal(await cards.first().getByText('外部任务：job-123').isVisible(), true)
    assert.equal(await cards.first().evaluate(card => {
      const outer = card.getBoundingClientRect()
      return [...card.querySelectorAll('details, details p')].every(node => {
        const box = node.getBoundingClientRect()
        return box.right <= outer.right && node.scrollWidth <= node.clientWidth + 1
      })
    }), true, `details overflow at ${width}`)
    await cards.first().getByRole('button', { name: '暂停 视频任务 0' }).click()
    await cards.first().getByRole('button', { name: '启用 视频任务 0' }).waitFor()
    assert.equal(await cards.first().getByRole('button', { name: '立即检查' }).isDisabled(), true)
    await cards.first().getByRole('button', { name: '启用 视频任务 0' }).click()
    await cards.first().getByRole('button', { name: '暂停 视频任务 0' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('button', { name: '新计划', exact: true }).click()
    const dialog = page.getByRole('dialog'); await dialog.waitFor()
    assert.equal(await dialog.locator('select[name=companionId] option').count(), 2)
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    await page.screenshot({ path: `/tmp/partner-wakeup-${width}-${dark ? 'dark' : 'light'}.png` })
    assert.deepEqual(errors, []); await page.close()
  }
  console.log('Schedule continuations: 375/800/1280 light/dark, terminal/revoked controls, details and eligible companion selection passed')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
