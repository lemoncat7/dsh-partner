import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { recordingNoteTool } from '../lib/concern-recording.js'
import { heartbeatToolPolicy } from '../lib/agent-runtime.js'

test('recording destination survives restart and stays separate from source resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'concern-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PartnerConcernStore(root)
  const target = { kind: 'note', locator: 'note-1', label: '观察记录' }
  const created = await store.createExplicit('c', '*', '关注 @instructions.md', '', target)
  const [restored] = await new PartnerConcernStore(root).list('c')
  assert.deepEqual(restored.recordTarget, target)
  assert.equal(restored.resources[0].locator, 'instructions.md')
  assert.equal(heartbeatToolPolicy([restored], ['write', 'knowledge_note_update']).allowed.size, 0)
  const merged = await store.createExplicit('c', '*', '关注 @instructions.md')
  assert.equal(merged.id, created.id)
  assert.deepEqual(merged.recordTarget, target)
  const other = await store.createExplicit('c', '*', '别的事情')
  assert.equal(other.recordTarget, undefined)
})

test('recording note tool only writes the selected target and enforces revision', async () => {
  let content = 'original'
  const calls = []
  const bridge = { version: 1,
    async read(id) { assert.equal(id, 'note-1'); return { id, name: '记录', content, revision: 'r1' } },
    async update(id, value, revision) { calls.push({ id, value, revision }); content = value; return { changed: true } },
  }
  const synced = []
  const tool = recordingNoteTool([{ id: 'c1', recordTarget: { kind: 'note', locator: 'note-1', label: '记录' } }], () => bridge, id => synced.push(id))
  const exec = { signal: new AbortController().signal }
  const read = JSON.parse(await tool.execute({ concernId: 'c1', operation: 'read' }, exec))
  assert.equal(read.content, 'original')
  await assert.rejects(tool.execute({ concernId: 'other', operation: 'append', content: 'bad', revision: 'r1' }, exec), /没有明确选择/)
  await assert.rejects(tool.execute({ concernId: 'c1', operation: 'append', content: 'bad', revision: 'old' }, exec), /重新读取/)
  assert.deepEqual(synced, [], 'reads and failed writes do not count as synchronized')
  await tool.execute({ concernId: 'c1', operation: 'append', content: '\nnew', revision: read.revision }, exec)
  assert.deepEqual(calls, [{ id: 'note-1', value: 'original\nnew', revision: 'r1' }])
  assert.deepEqual(synced, ['c1'])
})
