import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAvatarImage } from '../lib/channels/avatar-file.js'
import { updateDirectAvatar } from '../lib/channels/direct/avatar.js'
import { ChannelAvatarService } from '../lib/channels/avatar-tool.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const signal = () => new AbortController().signal
async function server(t, handler) {
  const requests = []
  const instance = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part)
    requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) })
    const result = handler(req, requests)
    res.statusCode = result.status ?? 200
    res.setHeader('content-type', 'application/json')
    if (result.location) res.setHeader('location', result.location)
    res.end(JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections() }))
  return { url: `http://127.0.0.1:${instance.address().port}`, requests }
}
async function files(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-avatar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'image.png'), png)
  return root
}

test('avatar files are bounded local PNG/JPEG; URLs, HTML, directories, oversized and escaped paths fail', async t => {
  const root = await files(t), outside = await files(t)
  assert.equal((await readAvatarImage(root, 'image.png', signal())).mediaType, 'image/png')
  await writeFile(join(root, 'fake.png'), '<svg>not a PNG</svg>')
  await writeFile(join(root, 'large.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await symlink(join(outside, 'image.png'), join(root, 'escape.png'))
  for (const path of ['https://example.com/image.png', 'fake.png', 'large.png', '.', 'escape.png', join(outside, 'image.png')]) await assert.rejects(readAvatarImage(root, path, signal()), undefined, path)
})

test('Matrix uploads bytes then sets only the verified account profile with mxc URI', async t => {
  const s = await server(t, req => ({ body: req.url.endsWith('whoami') ? { user_id: '@bot:local' } : req.url.includes('/upload') ? { content_uri: 'mxc://local/image' } : {} }))
  const result = await updateDirectAvatar({ platform: 'matrix', baseUrl: s.url, targetId: '' }, 'private-token', '@bot:local', { bytes: png, mediaType: 'image/png' }, signal(), () => {})
  assert.equal(result.avatar, 'mxc://local/image')
  assert.deepEqual(s.requests.map(item => item.method), ['GET', 'POST', 'PUT'])
  assert.ok(s.requests.every(item => item.headers.authorization === 'Bearer private-token'))
  assert.deepEqual(s.requests[1].body, png)
  assert.equal(s.requests[1].headers['content-type'], 'image/png')
  assert.equal(s.requests[2].path, '/_matrix/client/v3/profile/%40bot%3Alocal/avatar_url')
  assert.deepEqual(JSON.parse(s.requests[2].body), { avatar_url: 'mxc://local/image' })
})

test('Mattermost uses multipart image upload to the authenticated account, not an arbitrary target', async t => {
  const s = await server(t, () => ({ body: { id: 'bot', status: 'OK' } }))
  await updateDirectAvatar({ platform: 'mattermost', baseUrl: s.url, targetId: '' }, 'private-token', 'bot', { bytes: png, mediaType: 'image/png' }, signal(), () => {})
  assert.equal(s.requests[1].path, '/api/v4/users/bot/image')
  assert.equal(s.requests[1].method, 'POST')
  assert.match(s.requests[1].headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.ok(s.requests[1].body.includes(png))
  assert.match(s.requests[1].body.toString(), /name="image"/)
})

test('wrong account, upload failure, redirects and invalid media URI never set Matrix profile', async t => {
  for (const mode of ['wrong-account', 'upload-failed', 'redirect', 'invalid-uri']) {
    const s = await server(t, req => req.url.endsWith('whoami') ? { body: { user_id: mode === 'wrong-account' ? '@other:local' : '@bot:local' } }
      : mode === 'redirect' ? { status: 302, location: 'http://localhost:1', body: {} }
      : mode === 'upload-failed' ? { status: 403, body: { secret: 'private-token' } } : { body: { content_uri: 'https://untrusted/avatar.png' } })
    await assert.rejects(updateDirectAvatar({ platform: 'matrix', baseUrl: s.url, targetId: '' }, 'private-token', '@bot:local', { bytes: png, mediaType: 'image/png' }, signal(), () => {}), error => !error.message.includes('private-token'))
    assert.ok(!s.requests.some(item => item.method === 'PUT'))
  }
})

test('revoking permission after upload prevents the profile mutation', async t => {
  let revoked = false
  const s = await server(t, req => {
    if (req.url.includes('/upload')) { revoked = true; return { body: { content_uri: 'mxc://local/image' } } }
    return { body: { user_id: '@bot:local' } }
  })
  await assert.rejects(updateDirectAvatar({ platform: 'matrix', baseUrl: s.url, targetId: '' }, 'token', '@bot:local', { bytes: png, mediaType: 'image/png' }, signal(), () => { if (revoked) throw new Error('revoked') }), /revoked/)
  assert.ok(!s.requests.some(item => item.method === 'PUT'))
})

test('self-avatar is available by default with session ownership, own channel and shared-account protection', async t => {
  const root = await files(t)
  const s = await server(t, req => ({ body: req.url.endsWith('whoami') ? { user_id: '@bot:local' } : req.url.includes('/upload') ? { content_uri: 'mxc://local/image' } : {} }))
  const state = { companions: [{ id: 'c', capabilities: [] }], sessions: [{ sessionId: 's', companionId: 'c' }], channels: [{ id: 'mx', name: 'Matrix', platform: 'matrix', companionId: 'c', accountId: '@bot:local', enabled: true, direct: { baseUrl: s.url, targetId: '' } }] }
  const store = { snapshot: () => structuredClone(state), isCompanionRemoving: () => false }
  const service = new ChannelAvatarService(store, { read: async () => ({ baseUrl: s.url, botToken: 'private-token' }) })
  const tool = service.tool('c'), exec = { agent: { session: { id: 's', header: { cwd: root } } }, signal: signal() }
  assert.equal(JSON.parse(await tool.execute({ action: 'list' }, exec)).channels.length, 1)
  await assert.rejects(tool.execute({ action: 'set', channelId: 'other', path: 'image.png' }, exec), /不属于/)
  state.channels.push({ ...state.channels[0], id: 'shared', companionId: 'other' })
  await assert.rejects(tool.execute({ action: 'set', channelId: 'mx', path: 'image.png' }, exec), /共用/)
  state.channels.pop()
  const result = await tool.execute({ action: 'set', channelId: 'mx', path: 'image.png' }, exec)
  assert.equal(JSON.parse(result).updated, true); assert.ok(!result.includes('private-token'))
  exec.agent.session.id = 'other'
  await assert.rejects(tool.execute({ action: 'list' }, exec), /不属于/)
  exec.agent.session.id = 's'
  state.companions = []
  await assert.rejects(tool.execute({ action: 'list' }, exec), /已删除/)
})
