// Isolated identity editor fixture: never deletes live companions or files.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {IdentityEditor} from './src/ui/identity-editor';
function Fixture(){const [id,setId]=useState('a');const [home,setHome]=useState(false);window.switchTarget=next=>{setId(next);setHome(false)};
const companion={id,name:id==='a'?'甲伙伴':'乙伙伴',role:'测试',description:'',instructions:'',capabilities:[],createdAt:1,updatedAt:1};
return <main className="dsh-partner-workspace"><div>{home?<p role="status">伙伴总览</p>:<IdentityEditor companion={companion} count={2} onChanged={async()=>{}} onRemoved={async target=>{window.removedId=target;if(window.failRefresh)throw Error('刷新失败');if(target===id)setHome(true)}}/>}</div></main>}
createRoot(document.getElementById('app')).render(<Fixture/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'text' } })
const styles = (await Promise.all(['src/client.css', 'src/ui/workspace-ui.css', 'src/ui/responsive-ui.css'].map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')))).join('\n')
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].contents : '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script src="/app.js"></script>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const errors = [], requests = []
  let receive
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/partner-local/v1/**', route => { requests.push(route.request().url()); receive(route) })
  const reset = async (width = 1280, dark = false) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.addStyleTag({ content: styles })
    await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
    await page.getByRole('button', { name: '删除', exact: true }).waitFor()
  }
  const startDelete = async () => {
    await page.getByRole('button', { name: '删除', exact: true }).click()
    assert.match(await page.locator('.dsh-partner-identity-danger strong').innerText(), /甲伙伴/)
    const next = new Promise(resolve => { receive = resolve })
    await page.getByRole('button', { name: '确认删除', exact: true }).evaluate(button => { button.click(); button.click() })
    const route = await next
    assert.equal(await page.getByRole('button', { name: '正在删除…', exact: true }).isDisabled(), true)
    return route
  }
  for (const width of [375, 844, 1280]) for (const dark of [false, true]) {
    await reset(width, dark)
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.evaluate(() => window.switchTarget('b'))
    await page.waitForFunction(() => document.querySelector('input')?.value === '乙伙伴')
    assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).count(), 0)
    await page.evaluate(() => window.switchTarget('a'))
    await page.waitForFunction(() => document.querySelector('input')?.value === '甲伙伴')
    assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).count(), 0)
    const before = requests.length
    const route = await startDelete()
    assert.equal(requests.length, before + 1)
    assert.ok(route.request().url().endsWith('/a?removeFiles=1'))
    await route.fulfill({ status: 204 })
    await page.getByRole('status').filter({ hasText: '伙伴总览' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).count(), 0)
  }
  await reset()
  await page.evaluate(() => { window.failRefresh = true })
  await (await startDelete()).fulfill({ status: 204 })
  await page.getByRole('alert').waitFor()
  assert.match(await page.getByRole('alert').innerText(), /已删除.*不要再次删除/)
  assert.equal(await page.getByRole('button', { name: '已删除', exact: true }).isDisabled(), true)
  await reset()
  await (await startDelete()).fulfill({ status: 409, json: { error: '伙伴正在执行' } })
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isEnabled(), true)
  assert.deepEqual(errors, [])
  console.log('Companion deletion: target-bound confirmation, switch/reset, duplicate prevention, success navigation and error recovery; six responsive/theme cases passed.')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
