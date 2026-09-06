import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PartnerInboxStore } from '../lib/notifications/store.js'
import { PartnerNoticeService } from '../lib/notifications/service.js'
import { PartnerStore } from '../lib/store.js'
import { dispatchPendantApi } from '../lib/api/features/pendant-api.js'

const notice = (id, at = 1) => ({ id, kind: 'task', companionId: 'c', companionName: '伙伴', title: '完成', summary: '结果已经保存', createdAt: at })
test('inbox persists read state, bounds history and deduplicates terminal events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-inbox-'))
  let inbox
  try {
    const path = join(dir, 'inbox.sqlite')
    inbox = await PartnerInboxStore.open(path)
    inbox.append(notice('one')); const etag = inbox.etag
    inbox.append(notice('one')); assert.equal(inbox.etag, etag)
    assert.equal(inbox.snapshot().unread, 1)
    inbox.markRead(['one']); assert.equal(inbox.snapshot().unread, 0)
    assert.notEqual(inbox.etag, etag)
    inbox.close(); inbox = await PartnerInboxStore.open(path)
    assert.equal(inbox.snapshot().unread, 0)
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    for (let i = 0; i < 210; i++) inbox.append({ ...notice(`item-${i}`, i + 2), summary: 'x'.repeat(5000) })
    assert.equal(inbox.snapshot().items.length, 200)
    assert.equal(inbox.snapshot().items[0].id, 'item-209')
    assert.equal(inbox.snapshot().items[0].summary.length, 2000)
  } finally { inbox?.close(); await rm(dir, { recursive: true, force: true }) }
})

test('domain notifications report final tasks and schedules, not review handoff or ordinary writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-notices-'))
  const inbox = await PartnerInboxStore.open(join(dir, 'inbox.sqlite'))
  let service
  try {
    const store = await PartnerStore.open(join(dir, 'state.json'))
    const id = store.snapshot().companions[0].id
    const errors = []
    service = new PartnerNoticeService(store, inbox, error => errors.push(error))
    await store.update(state => state.tasks.push({ id: 'task1', title: '整理资料', description: '', status: 'review', priority: 'normal', assigneeCompanionId: id, createdBy: 'user', skillIds: [], dependencyTaskIds: [], resultAbstract: '已整理 3 篇文档', reviewHandoff: '内部验收：请再核验', revision: 1, createdAt: 1, updatedAt: 1 }))
    assert.equal(inbox.snapshot().items.length, 0)
    await store.update(state => { state.tasks[0].status = 'done'; state.tasks[0].updatedAt = 2; state.tasks[0].revision++ })
    assert.equal(inbox.snapshot().items.length, 1)
    assert.equal(inbox.snapshot().items[0].summary, '已整理 3 篇文档')
    await store.update(state => { state.tasks[0].revision++ })
    assert.equal(inbox.snapshot().items.length, 1)
    await store.update(state => state.executionRuns.push({ id: 'run1', kind: 'schedule', ownerCompanionId: id, sessionId: 'temp', sourceId: 'schedule1', status: 'completed', startedAt: 1, completedAt: 3, destroyAfterRun: true, outputSummary: '日报生成完成', toolNames: [] }))
    assert.equal(inbox.snapshot().items[0].kind, 'schedule')
    assert.deepEqual(errors, [])
  } finally { service?.close(); inbox.close(); await rm(dir, { recursive: true, force: true }) }
})

test('normal companion replies persist once, excluding foreign sessions, internal turns and interrupted output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-reply-notices-'))
  const inbox = await PartnerInboxStore.open(join(dir, 'inbox.sqlite'))
  let service
  try {
    const store = await PartnerStore.open(join(dir, 'state.json'))
    const companionId = store.snapshot().companions[0].id
    await store.update(state => state.sessions.push({ id: 'route1', kind: 'local', companionId, channelId: '', userId: 'local', sessionId: 's1', lastMessageAt: 1 }))
    const errors = []
    service = new PartnerNoticeService(store, inbox, error => errors.push(error))
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '整理一下' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '准备开始整理' }] } } },
      { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '已整理到文档中' }] } } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const session = { id: 's1', snapshotEvents: () => events }
    service.observeSession({ ...session, id: 'foreign' }, events.at(-1)); assert.equal(inbox.snapshot().unread, 0)
    service.observeSession(session, events.at(-1)); service.observeSession(session, events.at(-1)); assert.equal(inbox.snapshot().unread, 1)
    assert.equal(inbox.snapshot().items[0].summary, '已整理到文档中', 'only the final conclusion, not intermediate tool planning')
    events[0].data.turn = 2; events.at(-1).data.turn = 2; events[1].data.source = { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice' }
    service.observeSession(session, events.at(-1)); assert.equal(inbox.snapshot().unread, 1)
    assert.deepEqual(errors, [])
  } finally { service?.close(); inbox.close(); await rm(dir, { recursive: true, force: true }) }
})

test('inbox API supports conditional GET and guards read mutations and static paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-inbox-api-'))
  const inbox = await PartnerInboxStore.open(join(dir, 'inbox.sqlite'))
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } })
  try {
    inbox.append(notice('one'))
    const first = response()
    await dispatchPendantApi({ method: 'GET', headers: {} }, first, ['pendant', 'inbox'], inbox)
    assert.equal(JSON.parse(first.body).unread, 1)
    const unchanged = response()
    await dispatchPendantApi({ method: 'GET', headers: { 'if-none-match': first.headers.etag } }, unchanged, ['pendant', 'inbox'], inbox)
    assert.equal(unchanged.statusCode, 304); assert.equal(unchanged.body, undefined)
    await assert.rejects(dispatchPendantApi({ method: 'POST', headers: {} }, response(), ['pendant', 'read'], inbox), /mutation request header/)
    await assert.rejects(dispatchPendantApi({ method: 'GET', headers: {} }, response(), ['pendant', '..', 'state.json'], inbox), /unknown pendant/)
  } finally { inbox.close(); await rm(dir, { recursive: true, force: true }) }
})

test('failed notification observers cannot reject a committed partner update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-observer-'))
  try {
    const path = join(dir, 'state.json'), errors = []
    const store = await PartnerStore.open(path)
    const stop = store.subscribe(() => { throw new Error('notification unavailable') }, error => errors.push(error.message))
    await store.update(state => { state.companions[0].name = '保留修改' })
    assert.equal((await PartnerStore.open(path)).snapshot().companions[0].name, '保留修改')
    assert.deepEqual(errors, ['notification unavailable'])
    stop()
    await store.update(state => { state.companions[0].name = '再次修改' })
    assert.equal(errors.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
