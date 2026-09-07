import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {PartnerPendant} from './src/pendant/widget'; const root=createRoot(document.getElementById('overlay')); window.disposeFixture=()=>root.unmount(); root.render(<PartnerPendant controller={{open(){},openSession:async()=>{}}}/>);`, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' } })
const renderer = await readFile(new URL('../lib/pendant-renderer.js', import.meta.url))
const styles = await readFile(new URL('../src/pendant/widget.css', import.meta.url), 'utf8')
const server = createServer((req, res) => {
  if (req.url === '/partner-local/v1/pendant/inbox') { res.setHeader('Content-Type', 'application/json'); res.end('{"items":[],"unread":0}'); return }
  if (req.url?.endsWith('.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(req.url === '/app.js' ? bundle.outputFiles[0].contents : renderer); return }
  res.setHeader('Content-Type', 'text/html')
  res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#e8e9eb}#overlay{position:absolute;left:108px;top:62px;width:calc(100vw - 140px);height:calc(100vh - 90px)}</style><div id="overlay"></div><script src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('dsh-partner:pendant-position:v1', JSON.stringify({ x: .25, y: .2 })))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.addStyleTag({ content: styles })
  await page.waitForSelector('canvas[data-ready="true"]', { timeout: 40000 })
  const alignment = () => page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    const canvas = box('canvas'), hit = box('.dsh-partner-pendant-hit'), anchor = box('.dsh-partner-pendant-anchor'), stud = box('.dsh-partner-pendant-strap circle')
    return { card: Math.hypot(canvas.x + canvas.width / 2 - hit.x - hit.width / 2, canvas.y + canvas.height / 2 - hit.y - hit.height / 2), hook: Math.hypot(anchor.x + anchor.width / 2 - stud.x - stud.width / 2, anchor.y + anchor.height / 2 - stud.y - stud.height / 2) }
  })
  const check = async label => {
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas').getBoundingClientRect(), hit = document.querySelector('.dsh-partner-pendant-hit').getBoundingClientRect()
      const anchor = document.querySelector('.dsh-partner-pendant-anchor').getBoundingClientRect(), stud = document.querySelector('.dsh-partner-pendant-strap circle').getBoundingClientRect()
      // A viewport change may resize CSS before ResizeObserver repaints the rope.
      // Wait for both layers, not just the card/hit pair that already agrees.
      return Math.hypot(canvas.x + canvas.width / 2 - hit.x - hit.width / 2, canvas.y + canvas.height / 2 - hit.y - hit.height / 2) < 1
        && Math.hypot(anchor.x + anchor.width / 2 - stud.x - stud.width / 2, anchor.y + anchor.height / 2 - stud.y - stud.height / 2) < 1
    }, { }, { timeout: 5000 })
    const result = await alignment()
    assert.ok(result.card < 1 && result.hook < 1, `${label}: ${JSON.stringify(result)}`)
    console.log(label, result)
  }
  await check('positioned overlay without fixed containing block')
  for (const [name, style] of [['transform', 'translate3d(24px, 17px, 0)'], ['filter', 'blur(0px)'], ['contain', 'layout']]) {
    await page.evaluate(({ name, style }) => {
      const overlay = document.getElementById('overlay')
      overlay.style.transform = ''; overlay.style.filter = ''; overlay.style.contain = ''
      overlay.style[name] = style
      window.dispatchEvent(new Event('resize'))
    }, { name, style })
    await check(name + ' containing block')
  }
  const hook = page.getByRole('button', { name: '移动挂饰位置', exact: true })
  const before = await hook.boundingBox()
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down(); await page.mouse.move(before.x + before.width / 2 + 70, before.y + before.height / 2 + 40, { steps: 10 }); await page.mouse.up()
  const after = await hook.boundingBox()
  assert.ok(Math.abs(after.x - before.x - 70) < 1 && Math.abs(after.y - before.y - 40) < 1, 'hook drag must not add overlay offset a second time')
  await check('hook drag')
  await hook.focus(); await page.keyboard.press('ArrowRight')
  const keyed = await hook.boundingBox()
  assert.ok(Math.abs(keyed.x - after.x - 12) < 1, 'keyboard movement uses local CSS pixels')
  await check('keyboard placement')
  const hit = page.locator('.dsh-partner-pendant-hit')
  const card = await hit.boundingBox(), target = { x: card.x + card.width / 2 + 130, y: card.y + card.height / 2 + 80 }
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2); await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 12 }); await page.waitForTimeout(200)
  const dragged = await hit.boundingBox()
  assert.ok(Math.hypot(dragged.x + dragged.width / 2 - target.x, dragged.y + dragged.height / 2 - target.y) < 12, 'card drag follows viewport pointer')
  await check('card drag'); await page.mouse.up()
  await page.evaluate(() => { document.getElementById('overlay').style.left = '37px'; document.getElementById('overlay').style.top = '28px'; window.dispatchEvent(new Event('resize')) })
  await check('overlay relayout')
  await page.screenshot({ path: '/tmp/partner-pendant-offset-overlay.png' })
  for (const viewport of [{ width: 375, height: 844 }, { width: 844, height: 375 }]) {
    await page.setViewportSize(viewport)
    await check(`viewport ${viewport.width}x${viewport.height}`)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await check('reduced motion')
  await page.evaluate(() => window.disposeFixture())
  assert.equal(await page.locator('canvas, .dsh-partner-pendant-strap').count(), 0)
  assert.deepEqual(errors, [])
  console.log('Pendant coordinate regression passed; fixture only, no live data changes.')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
