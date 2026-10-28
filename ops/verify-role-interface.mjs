// Local deployment check: boot the actual web profile without sending any messages.
// Run where Docker is available, with PARTNER_PLAYWRIGHT_MODULE pointing to Playwright.
import assert from 'node:assert/strict'
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
        for(const width of [1280,375]) {
          await page.setViewportSize({width,height:900})
          const reference=page.getByRole('button',{name:'查看大肥鱼参考',exact:true})
          await reference.click()
          const dialog=page.getByRole('dialog')
          await dialog.getByText('展开原版角色卡 · 只读',{exact:true}).click()
          assert.ok((await dialog.locator('pre').innerText()).includes('能一句答完就别加戏'))
          assert.ok(await dialog.locator('section').first().evaluate(n=>n.getBoundingClientRect().width<=innerWidth))
          await page.screenshot({path:`/tmp/partner-reference-${width}.png`})
          await page.keyboard.press('Escape')
          assert.equal(await reference.evaluate(n=>document.activeElement===n),true)
          await page.locator('summary').filter({hasText:'背景资料'}).click()
          const lore=page.locator('.dsh-partner-character-lore').first()
          await lore.locator('summary').click()
          const spacing=await lore.locator('.dsh-partner-character-check').evaluate(n=>{const box=n.querySelector('input').getBoundingClientRect(),text=n.querySelector('span').getBoundingClientRect();return {gap:text.left-box.right,height:n.getBoundingClientRect().height}})
          assert.ok(spacing.gap>=10,JSON.stringify(spacing));assert.ok(spacing.height>=44)
          await lore.scrollIntoViewIfNeeded()
          await page.screenshot({path:`/tmp/partner-lore-${width}.png`})
          await lore.locator('summary').click()
          await page.locator('summary').filter({hasText:'背景资料'}).click()
        }
        await page.getByRole('tab',{name:'聊天方式',exact:true}).click()
        assert.equal(await page.getByRole('checkbox',{name:/允许分段回复/}).isChecked(),true)
        await page.getByRole('button',{name:'管理表情库'}).click()
        const library=page.getByRole('dialog')
        await library.getByText('大肥鱼的表情从哪里来？',{exact:true}).click()
        await library.getByText('导入收藏图片',{exact:true}).click()
        await library.getByLabel('收藏资料（可选）',{exact:false}).setInputFiles({name:'stickers.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([{id:'local-fixture',desc:'匹配预览',tags:['开心']}]))})
        await library.getByText('已读取 1 条收藏资料。',{exact:true}).waitFor()
        await library.getByLabel('选择图片',{exact:false}).setInputFiles({name:'local-fixture.png',mimeType:'image/png',buffer:Buffer.from('preview only')})
        await library.getByText('匹配预览',{exact:true}).waitFor()
        await library.getByText('已匹配收藏资料 · 开心',{exact:true}).waitFor()
        await page.screenshot({path:'/tmp/partner-import-375.png'})
        // Preview only: never press import or save on this real companion.
        await page.keyboard.press('Escape')
        const after=await (await page.request.get(base+'/partner-local/v1')).json()
        assert.equal(JSON.stringify(after.companions.find(c=>c.name==='莫殇').characterCard),beforeCard)
        console.log('Production role reference, focus restoration, checkbox spacing, mobile layout and collection import preview verified; no settings or images saved, no messages sent.')
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
