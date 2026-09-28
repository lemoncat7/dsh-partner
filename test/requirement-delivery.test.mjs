import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'
import { requirementAttachments } from '../lib/requirements/attachments.js'
import { PartnerStore } from '../lib/store.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { ChannelManager } from '../lib/channels/manager.js'
import { RequirementWorker } from '../lib/requirements/worker.js'
import { RequirementService } from '../lib/requirements/service.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'requirement-delivery-'))
  const cwd = join(root, 'worker'); await mkdir(cwd)
  const service = await AttachmentDeliveryService.open(join(root, 'files'))
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  await writeFile(join(cwd, 'final.mp4'), 'immutable video')
  const file = await service.prepare({ companionId: 'worker', sessionId: 'worker-session', turn: 1, cwd, path: 'final.mp4', channel: false }, new AbortController().signal)
  const store = await PartnerStore.open(join(root, 'state.json'))
  const task = { id: 'task', title: 'video', assigneeCompanionId: 'worker', resultAttachmentIds: [file.id], resultSummary: '视频已完成' }
  const item = { id: 'requirement', title: '视频需求', description: '', status: 'done', revision: 1, createdAt: 1, updatedAt: 2, ownerCompanionId: 'companion-default', creatorSessionId: 'origin', summary: '最终视频已完成', results: [task] }
  await store.update(s => {
    s.companions.push({ ...s.companions[0], id: 'worker' })
    s.requirements = [item]
    s.sessions.push({ id: 'route', kind: 'channel', companionId: 'companion-default', sessionId: 'origin', channelId: 'matrix', userId: 'user', cwd: root, lastMessageAt: 1 })
    s.channels.push({ id: 'matrix', companionId: 'companion-default', enabled: true })
    s.pairings.push({ channelId: 'matrix', userId: 'user', status: 'approved', lastInboundAt: 1 })
  })
  return { root, cwd, service, file, store, task, item }
}

test('accepted explicit snapshots survive source deletion; legacy delivery IDs work without guessing paths', async t => {
  const f = await fixture(t)
  await rm(join(f.cwd, 'final.mp4'))
  assert.deepEqual((await requirementAttachments(f.item, f.store.snapshot(), f.service)).map(f => f.id), [f.file.id])
  assert.equal((await f.service.bytes(f.file)).toString(), 'immutable video')
  const legacy = { ...f.item, results: [{ ...f.task, resultAttachmentIds: undefined, resultSummary: `附件 deliveryId ${f.file.id}` }] }
  assert.equal((await requirementAttachments(legacy, f.store.snapshot(), f.service)).length, 1)
  assert.equal((await requirementAttachments({ ...legacy, results: [{ ...legacy.results[0], resultSummary: '/other/private.md' }] }, f.store.snapshot(), f.service)).length, 0)
  await assert.rejects(requirementAttachments({ ...f.item, results: [{ ...f.task, assigneeCompanionId: 'other' }] }, f.store.snapshot(), f.service), /不属于/)
  await assert.rejects(requirementAttachments({ ...f.item, results: [{ ...f.task, resultAttachmentIds: ['a'.repeat(64)] }] }, f.store.snapshot(), f.service), /不存在/)
})

test('original conversation receives summary and download link exactly once, without another model turn', async t => {
  const f = await fixture(t), events = []
  const session = { snapshotEvents: () => events, append: (type, data, opts) => { assert.equal(opts.surfaceOp, 'append'); events.push({ type, data }) } }
  const runtime = { store: f.store, isArchived: () => false, ensureAgent: async () => ({ session }) }
  const route = f.store.snapshot().sessions[0]
  for (let i = 0; i < 2; i++) await PartnerAgentRuntime.prototype.recordRequirementResult.call(runtime, route, 'stable-receipt', '最终总结', [f.file], f.service, '/partner')
  assert.equal(events.length, 1)
  assert.match(events[0].data.content[0].text, /最终总结/)
  assert.match(events[0].data.content[1].text, new RegExp(`/attachments/${f.file.id}`))
})

test('channel attachment failure never completes requirement; restart retries only missing channel parts', async t => {
  const f = await fixture(t), events = [], sends = []
  let fail = true
  const make = store => {
    const runtime = { store, isArchived: () => false, ensureAgent: async () => ({ session: { snapshotEvents: () => events, append: (type, data) => events.push({ type, data }) } }) }
    const agents = { recordRequirementResult: (...args) => PartnerAgentRuntime.prototype.recordRequirementResult.call(runtime, ...args) }
    const channels = new ChannelManager({}, store, {}, agents, f.root)
    channels.setRequirementDelivery(f.service, '/partner')
    channels.sendNotificationTarget = async (_channel, _user, reply, part) => {
      assert.equal(reply.attachments.length, 1)
      await part(0, async () => { sends.push('text') })
      await part(1, async () => { if (fail) throw new Error('network'); sends.push('video') })
    }
    return new RequirementWorker(store, new RequirementService(store), { summarize: () => assert.fail('already summarized'), deliver: item => channels.notifyRequirementResult(item), warn() {} })
  }
  const worker = make(f.store)
  await worker.tick(); await worker.close()
  assert.equal(f.store.snapshot().requirements[0].notifiedAt, undefined)
  assert.ok(f.store.snapshot().requirements[0].lastError)
  assert.equal(events.length, 1)
  const restored = await PartnerStore.open(join(f.root, 'state.json'))
  await new RequirementService(restored).retry(f.item.id)
  fail = false
  const restarted = make(restored); await restarted.tick(); await restarted.tick(); await restarted.close()
  assert.ok(restored.snapshot().requirements[0].notifiedAt)
  assert.deepEqual(sends, ['text', 'video'])
  assert.equal(events.length, 1)
})

test('browser-only requirement still publishes summary and attachments without a channel', async t => {
  const f = await fixture(t), recorded = []
  await f.store.update(s => { s.sessions[0].kind = 'local'; s.sessions[0].channelId = '@local'; s.channels = []; s.pairings = [] })
  const channels = new ChannelManager({}, f.store, {}, { recordRequirementResult: async (...args) => recorded.push(args) }, f.root)
  channels.setRequirementDelivery(f.service, '/partner')
  channels.sendProactiveReply = () => assert.fail('must not send to unrelated channels')
  await channels.notifyRequirementResult(f.item)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0][3][0].id, f.file.id)
})

test('manual retry reopens legacy text-only delivery without reopening or regenerating work', async t => {
  const f = await fixture(t)
  await f.store.update(s => { s.requirements[0].notifiedAt = 100; s.recentReceipts.push('requirement-result:requirement:1') })
  await new RequirementService(f.store).retry(f.item.id)
  const current = f.store.snapshot().requirements[0]
  assert.equal(current.status, 'done'); assert.equal(current.summary, f.item.summary)
  assert.equal(current.notifiedAt, undefined)
  assert.deepEqual(current.results, f.item.results)
})

test('archiving retains explicit attachments when child cards are later removed', async t => {
  const f = await fixture(t)
  await f.store.update(s => {
    s.requirements[0].status = 'active'; delete s.requirements[0].results
    s.tasks = [{ ...f.task, requirementId: f.item.id, status: 'done', description: '', priority: 'normal', createdBy: 'user', skillIds: [], dependencyTaskIds: [], revision: 1, createdAt: 1, updatedAt: 2 }]
  })
  const archived = await new RequirementService(f.store).finish(f.item.id, 1, '最终交付', { kind: 'user' })
  await f.store.update(s => { s.tasks = [] })
  assert.deepEqual(archived.results[0].resultAttachmentIds, [f.file.id])
  assert.equal((await requirementAttachments(archived, f.store.snapshot(), f.service)).length, 1)
})
