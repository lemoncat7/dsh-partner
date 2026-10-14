import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createRendererLoader } from '../lib/pendant/renderer-loader.js'
import { staticPendantLayout } from '../lib/pendant/static-card.js'
import { dispatchPendantApi } from '../lib/api/features/pendant-api.js'

test('renderer is lazy, shares in-flight work, and retries after failure', async () => {
  let requests = 0
  const module = { createLanyard() {} }
  const load = createRendererLoader(async () => { if (++requests === 1) throw Error('offline'); return module })
  assert.equal(requests, 0)
  const first = load(); assert.equal(first, load())
  await assert.rejects(first, /offline/)
  assert.equal(await load(), module); assert.equal(await load(), module)
  assert.equal(requests, 2)
  await assert.rejects(createRendererLoader(async () => ({}))(), /Invalid pendant/)
})

test('native renderer chunk registers separately, without evaluating at initial registration', async () => {
  let registered
  const source = await readFile(new URL('../lib/client.pendant.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: module => { registered = module } } } })
  assert.equal(registered.id, '@lemoncat7/dsh-partner')
  assert.equal(registered.chunk, 'client.pendant.js')
  assert.equal(typeof registered.factory, 'function')
  const entry = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(entry.length < 1_500_000, 'physics must not leak into initial client')
  assert.ok(entry.includes('require.async("./client.pendant.js")'))
})

test('static card geometry follows viewport scale and strap length, badge stays above face', () => {
  for (const [width, height] of [[260,310],[200,248],[200,144]]) {
    const short = staticPendantLayout(width,height,60)
    const long = staticPendantLayout(width,height,160)
    assert.ok(short.height >= 44); assert.equal(short.width,long.width)
    assert.ok(long.y > short.y); assert.ok(short.badgeY < short.y-short.height/2)
    assert.ok(Math.abs((long.y-short.y)-(long.strapHeight-short.strapHeight))<1e-9)
  }
})

test('legacy renderer supports conditional GET without re-transferring the full bundle', async () => {
  const response = () => ({ headers: {}, setHeader(k,v) { this.headers[k]=v }, end(body) { this.body=body } })
  const first = response()
  await dispatchPendantApi({method:'GET',headers:{}},first,['pendant','renderer.js'],{})
  assert.ok(first.body.length > 1_000_000)
  assert.match(first.headers.etag,/^"[a-f0-9]{64}"$/)
  for (const tag of [first.headers.etag, `W/${first.headers.etag}`, `"other", ${first.headers.etag}`]) {
    const cached = response()
    await dispatchPendantApi({method:'GET',headers:{'if-none-match':tag}},cached,['pendant','renderer.js'],{})
    assert.equal(cached.statusCode,304); assert.equal(cached.body,undefined)
  }
  const changed = response()
  await dispatchPendantApi({method:'GET',headers:{'if-none-match':'"old"'}},changed,['pendant','renderer.js'],{})
  assert.equal(changed.body,first.body)
})
