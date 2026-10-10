import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PARTNER_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PARTNER_PLAYWRIGHT_MODULE).href : 'playwright-core')
const css = await readFile(new URL('../src/pendant/widget.css', import.meta.url), 'utf8')
assert.doesNotMatch(css, /cursor\s*:[^;}]*!important/)
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  for (const themeFirst of [true, false]) {
    await page.setContent('<body class="cursor-theme"><div class="dsh-partner-pendant"><button class="dsh-partner-pendant-hit">Card</button><button class="dsh-partner-pendant-anchor"><span></span></button></div></body>')
    const theme = 'body.cursor-theme button { cursor: crosshair; }'
    if (themeFirst) await page.addStyleTag({ content: theme })
    await page.addStyleTag({ content: css })
    if (!themeFirst) await page.addStyleTag({ content: theme })
    for (const themed of [false, true]) {
      await page.evaluate(on => document.body.classList.toggle('cursor-theme', on), themed)
      for (const selector of ['.dsh-partner-pendant-hit', '.dsh-partner-pendant-anchor']) {
        const button = page.locator(selector)
        const cursor = () => button.evaluate(el => getComputedStyle(el).cursor)
        await button.hover()
        assert.equal(await cursor(), themed ? 'crosshair' : 'grab')
        await page.mouse.down()
        assert.equal(await cursor(), themed ? 'crosshair' : 'grabbing')
        await page.mouse.up()
        assert.equal(await cursor(), themed ? 'crosshair' : 'grab')
        if (!themed) {
          await button.evaluate(el => { el.disabled = true })
          assert.equal(await cursor(), 'default')
          await button.evaluate(el => { el.disabled = false })
        }
      }
    }
  }
  console.log('PASS: card/anchor hover, press, release, disabled and normal theme override in both stylesheet orders')
} finally {
  await browser.close()
}
