// Local deployment check: boot the actual web profile without sending any messages.
// Run where Docker is available, with PARTNER_PLAYWRIGHT_MODULE pointing to Playwright.
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const container = process.env.PARTNER_CONTAINER || 'dsh-docker-dsh-1'
const base = 'http://127.0.0.1:3080'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 30e6 })
  if (result.status !== 0) throw Error('Docker readiness inspection failed')
  return (result.stdout || '') + (result.stderr || '')
}
async function verify() {
  assert.ok(process.env.PARTNER_PLAYWRIGHT_MODULE, 'Set PARTNER_PLAYWRIGHT_MODULE to the local Playwright module path')
  const { chromium } = await import(pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href)
  const deadline = Date.now() + 600_000
  let token
  while (Date.now() < deadline) {
    const ready = await fetch(base, { signal: AbortSignal.timeout(3000) }).then(response => response.ok || response.status === 401 || response.status === 403).catch(() => false)
    if (ready) {
      const started = docker(['inspect', '--format', '{{.State.StartedAt}}', container]).trim()
      token = [...docker(['logs', '--since', started, container]).matchAll(/\?token=([^\s)&]+)/g)].at(-1)?.[1]
      if (token) break
    }
    await delay(2000)
  }
  assert.ok(token, 'Web host did not become ready with a startup token')
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-webgl'] })
  try {
    const page = await browser.newPage()
    try { await page.goto(base + '/?token=' + encodeURIComponent(decodeURIComponent(token)), { waitUntil: 'domcontentloaded', timeout: 60_000 }) }
    catch { throw Error('Authenticated local web page failed to load') }
    const pluginDeadline = Date.now() + 240_000
    while (Date.now() < pluginDeadline) {
      const response = await page.request.get(base + '/partner-local/v1', { timeout: 10_000 }).catch(() => undefined)
      if (response?.status() === 200) {
        const snapshot = await response.json()
        assert.ok(Array.isArray(snapshot.companions))
        await page.locator('.dsh-partner-sidebar-row, .dsh-partner-rail').first().click({timeout:30000})
        await page.locator('.dsh-partner-roster-list button').filter({hasText:'莫殇'}).click()
        await page.getByRole('button',{name:'身份',exact:true}).click()
        const before=JSON.stringify(snapshot.companions.find(c=>c.name==='莫殇'))
        const artifacts=mkdtempSync(join(tmpdir(),'partner-idle-2115-'))
        for(const theme of ['light','dark']) for(const width of [1280,375]) {
          await page.evaluate(theme=>{document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');document.documentElement.dataset.xiaoheiAppearance=theme},theme)
          await page.setViewportSize({width,height:1000})
          await page.getByRole('tab',{name:'闲时主动联系',exact:false}).click()
          const toggle=page.getByRole('switch',{name:'开启闲时主动联系',exact:true})
          if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click()
          const section=page.getByRole('region',{name:'闲时主动联系',exact:true})
          const target=section.getByLabel('联系到哪里',{exact:false})
          await target.selectOption({index:1})
          assert.ok(await target.inputValue())
          await section.getByLabel('空闲多久后联系',{exact:false}).selectOption('60')
          assert.equal(await section.getByLabel('空闲多久后联系',{exact:false}).inputValue(),'60')
          await toggle.scrollIntoViewIfNeeded();await page.waitForTimeout(300)
          await page.screenshot({path:join(artifacts,`${theme}-${width}-idle.png`)})
          const checked=await toggle.evaluate(n=>({color:getComputedStyle(n).backgroundColor,x:n.querySelector('i').getBoundingClientRect().left-n.getBoundingClientRect().left}))
          await toggle.press('Space');await page.waitForTimeout(250)
          const unchecked=await toggle.evaluate(n=>({color:getComputedStyle(n).backgroundColor,x:n.querySelector('i').getBoundingClientRect().left-n.getBoundingClientRect().left}))
          assert.notEqual(checked.color,unchecked.color);assert.ok(checked.x-unchecked.x>=17)
          await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
          await page.getByRole('tab',{name:'聊天方式',exact:true}).click()
          await page.getByRole('button',{name:'管理表情库',exact:true}).click()
          const dialog=page.getByRole('dialog')
          await dialog.locator('.dsh-partner-sticker-grid img').first().waitFor()
          assert.equal(await dialog.locator('.dsh-partner-sticker-grid img').count(),20)
          await dialog.locator('.dsh-partner-sticker-grid img').first().scrollIntoViewIfNeeded()
          await page.waitForFunction(()=>Array.from(document.querySelectorAll('.dsh-partner-sticker-grid img')).filter(n=>n.getBoundingClientRect().top<innerHeight).every(n=>n.complete&&n.naturalWidth>0))
          await page.screenshot({path:join(artifacts,`${theme}-${width}-stickers.png`)})
          assert.ok(await dialog.getByRole('link',{name:'作者 Volpeon / Blobfox'}).count())
          await page.keyboard.press('Escape')
        }
        const after=await(await page.request.get(base+'/partner-local/v1')).json()
        assert.equal(JSON.stringify(after.companions.find(c=>c.name==='莫殇')),before)
        console.log('Artifacts: '+artifacts)
        console.log('Identity idle settings, target selection, visible switch states and 20 bundled stickers verified at 1280/375 light/dark; no settings saved or messages sent.')
        return
      }
      await delay(2000)
    }
    throw Error('Web profile opened but partner API did not become ready')
  } finally { await browser.close() }
}
verify().catch(error => {
  // Playwright errors can contain the navigation URL; never log its authentication token.
  console.error(String(error.message).replace(/token=[^\s)&"']+/g, 'token=REDACTED'))
  process.exitCode = 1
})
