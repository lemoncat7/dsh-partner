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
        await page.getByRole('tab',{name:'角色聊天',exact:false}).click()
        const beforeCard=JSON.stringify(snapshot.companions.find(c=>c.name==='莫殇').characterCard)
        const artifacts=mkdtempSync(join(tmpdir(),'partner-controls-2114-'))
        const toggle=page.getByRole('switch',{name:'启用角色聊天',exact:true})
        const initial=await toggle.getAttribute('aria-checked')
        const inspect=async()=>toggle.evaluate(n=>{const style=getComputedStyle(n),knob=n.querySelector('i'),box=n.getBoundingClientRect(),k=knob.getBoundingClientRect();return {background:style.backgroundColor,width:box.width,height:box.height,knobX:k.left-box.left,knobWidth:k.width,radius:style.borderRadius}})
        const inspectClose=async()=>page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).evaluate(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n),icon=n.querySelector('svg').getBoundingClientRect();return {width:b.width,height:b.height,padding:s.padding,radius:s.borderRadius,iconWidth:icon.width,iconHeight:icon.height,offsetX:icon.left-b.left,offsetY:icon.top-b.top}})
        for(const theme of ['light','dark']) for(const width of [1280,375]) {
          await page.evaluate(theme=>{document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');document.documentElement.dataset.xiaoheiAppearance=theme},theme)
          await page.setViewportSize({width,height:900})
          await page.getByRole('tab',{name:'角色设定',exact:true}).click()
          const selectedTab=await page.getByRole('tab',{name:'角色设定',exact:true}).evaluate(n=>getComputedStyle(n).backgroundColor)
          const otherTab=await page.getByRole('tab',{name:'聊天方式',exact:true}).evaluate(n=>getComputedStyle(n).backgroundColor)
          assert.notEqual(selectedTab,otherTab,'Selected settings tabs must remain visually distinct')
          if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click()
          await page.waitForTimeout(250)
          const on=await inspect()
          await toggle.scrollIntoViewIfNeeded()
          await page.screenshot({path:join(artifacts,`${theme}-${width}-on.png`)})
          assert.equal(await page.locator('.dsh-partner-character-toggle > span').innerText(),'已开启')
          await toggle.press('Space')
          assert.equal(await toggle.getAttribute('aria-checked'),'false')
          await page.waitForTimeout(250)
          const off=await inspect()
          await page.screenshot({path:join(artifacts,`${theme}-${width}-off.png`)})
          assert.equal(await page.locator('.dsh-partner-character-toggle > span').innerText(),'已关闭')
          assert.notEqual(on.background,off.background)
          assert.ok(on.knobX-off.knobX>=17)
          for(const state of [on,off]){assert.equal(state.width,44);assert.equal(state.height,26);assert.equal(state.knobWidth,18)}
          await toggle.click()
          const reference=page.getByRole('button',{name:'查看大肥鱼参考',exact:true})
          await reference.click()
          const refClose=await inspectClose()
          assert.equal(refClose.width,44);assert.equal(refClose.height,44);assert.equal(refClose.iconWidth,18);assert.equal(refClose.iconHeight,18);assert.equal(refClose.padding,'0px');assert.equal(refClose.radius,'50%')
          assert.ok(Math.abs(refClose.offsetX-13)<=1);assert.ok(Math.abs(refClose.offsetY-13)<=1)
          await page.screenshot({path:join(artifacts,`${theme}-${width}-close.png`)})
          const source=page.getByRole('dialog').getByRole('link',{name:'在 GitHub 查看对应版本'})
          await source.focus();await page.keyboard.press('Tab')
          assert.equal(await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).evaluate(n=>document.activeElement===n),true)
          await page.keyboard.press('Escape')
          assert.equal(await reference.evaluate(n=>document.activeElement===n),true)
          await page.getByRole('tab',{name:'聊天方式',exact:true}).click()
          await page.getByRole('button',{name:'管理表情库'}).click()
          assert.deepEqual(await inspectClose(),refClose)
          await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
        }
        if(await toggle.getAttribute('aria-checked')!==initial)await toggle.click()
        console.log('Artifacts: '+artifacts)
        const after=await (await page.request.get(base+'/partner-local/v1')).json()
        assert.equal(JSON.stringify(after.companions.find(c=>c.name==='莫殇').characterCard),beforeCard)
        console.log('Production: switch colors, thumb movement, visible state, keyboard operation and consistent 44px close buttons verified at 1280/375 in light/dark; no settings saved or messages sent.')
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
