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
        console.log(`Authenticated web profile and partner API ready: ${snapshot.companions.length} companions`)
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
