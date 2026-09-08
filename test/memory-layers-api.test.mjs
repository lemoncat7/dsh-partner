import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { dispatchMemoryLayersApi } from '../lib/api/features/memory-layers-api.js'

function response() {
  return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(value) { this.body = value && JSON.parse(value) } }
}
function request(method, body = {}, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, headers })
}

test('memory layer reads preserve companion/scope and do not intercept legacy memory routes', async () => {
  const res = response(); const args = []
  const store = { memoryLayers: async (...values) => { args.push(values); return { scenes: [], experiences: [], jobs: [] } } }
  assert.equal(await dispatchMemoryLayersApi(request('GET'), res, new URL('http://test/?scopeId=contact'), ['companions', 'c', 'memory', 'layers'], store, 'c'), true)
  assert.deepEqual(args, [['c', 'contact']])
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(await dispatchMemoryLayersApi(request('GET'), res, new URL('http://test/'), ['companions', 'c', 'memory'], store, 'c'), false)
})

test('draft review requires mutation header and carries exact version to the store', async () => {
  const res = response(); const args = []
  const store = { reviewExperience: async (...values) => args.push(values) }
  const url = new URL('http://test/?scopeId=s'); const segments = ['companions', 'c', 'memory', 'experiences', 'draft']
  await assert.rejects(dispatchMemoryLayersApi(request('POST', { action: 'approved', version: 'v1' }), res, url, segments, store, 'c'), /mutation request header/)
  assert.deepEqual(args, [])
  await dispatchMemoryLayersApi(request('POST', { action: 'approved', version: 'v1' }, { 'x-dsh-partner-request': '1' }), res, url, segments, store, 'c')
  assert.deepEqual(args, [['c', 's', 'draft', 'v1', 'approved']])
})

test('history rejects invalid cursors before querying storage', async () => {
  let called = false
  await assert.rejects(dispatchMemoryLayersApi(request('GET'), response(), new URL('http://test/?scopeId=s&before=NaN'),
    ['companions', 'c', 'memory', 'history'], { history: async () => { called = true } }, 'c'), /Invalid history cursor/)
  assert.equal(called, false)
})
