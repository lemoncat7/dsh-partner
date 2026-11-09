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

test('sync schema and execution reject append; patch preserves unrelated text and checks revision', async()=>{
 let body='human notes\nsection: old\nother section',revision='r1',writes=0
 const bridge={version:1,read:async()=>({id:'n',name:'note',content:body,revision}),update:async(_id,next)=>{body=next;revision='r2';writes++;return {changed:true}}}
 const tool=recordingNoteTool([{id:'c',recordTarget:{kind:'note',locator:'n'}}],()=>bridge,undefined,'sync')
 assert.deepEqual(tool.parameters.properties.operation.enum,['read','patch','replace'])
 await assert.rejects(tool.execute({concernId:'c',operation:'append',content:'x',revision:'r1'},{}),/不允许/)
 await assert.rejects(tool.execute({concernId:'c',operation:'patch',oldText:'absent',content:'x',revision:'r1'},{}),/唯一匹配/)
 await tool.execute({concernId:'c',operation:'patch',oldText:'section: old',content:'section: new',revision:'r1'},{})
 assert.equal(body,'human notes\nsection: new\nother section');assert.equal(writes,1)
 await assert.rejects(tool.execute({concernId:'c',operation:'patch',oldText:'section: new',content:'x',revision:'r1'},{}),/重新读取/)
 const reader=recordingNoteTool([{id:'c',recordTarget:{kind:'note',locator:'n'}}],()=>bridge,undefined,'read')
 assert.deepEqual(reader.parameters.properties.operation.enum,['read'])
 await assert.rejects(reader.execute({concernId:'c',operation:'replace',content:'x',revision:'r2'},{}),/不允许/)
})
