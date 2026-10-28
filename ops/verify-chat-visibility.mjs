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
        const name=process.env.PARTNER_VERIFY_NAME||'莫殇'
        await page.getByText(`伙伴 · ${name}`,{exact:true}).click({timeout:60000})
        await page.getByText(process.env.PARTNER_VERIFY_SESSION_TITLE||'greeting',{exact:true}).click({timeout:60000})
        const replies=page.locator('[data-chat-node-key^="18:partner-chat-reply"]')
        await replies.first().waitFor({state:'attached',timeout:60000})
        const rows=await replies.evaluateAll(nodes=>nodes.map(n=>({hidden:n.getAttribute('data-turn-process-hidden'),height:n.getBoundingClientRect().height})))
        assert.ok(rows.every(r=>r.hidden!=='true'&&r.height>0),'Replies must remain visible when native tool process is collapsed')
        assert.equal(await page.locator('.dsh-partner-chat-bubbles').count(),0)
        assert.ok((await replies.evaluateAll(nodes=>nodes.map(n=>n.dataset.chatFlowKind))).every(k=>k==='assistant-step'))
        const bodyClass=await replies.first().evaluate(n=>n.querySelector(':scope > [data-slot="conversation.chat.node"] > div')?.className)
        assert.ok(bodyClass,'Native assistant body must exist')
        const normal=page.locator('[data-chat-flow-kind="assistant-step"][data-chat-node-key^="14:assistant-step"] > [data-slot="conversation.chat.node"] > div').first()
        assert.equal(await normal.getAttribute('class'),bodyClass,'Both paths must use the same host body')
        for(const width of [1280,375]) {
          await page.setViewportSize({width,height:900})
          await replies.last().scrollIntoViewIfNeeded()
          await page.waitForTimeout(700)
          assert.ok(await replies.last().evaluate(n=>n.getBoundingClientRect().width<=innerWidth),'Reply must fit viewport')
          await page.screenshot({path:`/tmp/partner-native-chat-${width}.png`})
        }
        const images=replies.locator('img')
        assert.ok(await images.count()>0,'Fixture history must include a rendered sticker, not an image fallback')
        assert.equal(await replies.getByText(/图片无法预览/).count(),0)
        for(const img of await images.all()) await img.scrollIntoViewIfNeeded()
        await page.waitForFunction(()=>[...document.querySelectorAll('[data-chat-node-key^="18:partner-chat-reply"] img')].every(i=>i.complete&&i.naturalWidth>0))
        console.log(`Production conversation: ${rows.length} existing replies visible outside process folding; no messages sent.`)
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
