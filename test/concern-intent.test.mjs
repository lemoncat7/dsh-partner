import test from 'node:test'
import assert from 'node:assert/strict'
import { registerPartnerConcernTool } from '../lib/concern-tool.js'
import { explicitConcernDirective } from '../lib/memory-reflection.js'

test('explicit watch phrases are recognized without treating fixed reports as watches', () => {
  for (const text of ['关注一些项目的版本变化', '帮我关注项目更新', '有变化告诉我', '每天检查一下，有更新再通知我']) assert.equal(explicitConcernDirective(text), true, text)
  for (const text of ['每天九点生成并发送日报', '不用再关注这个项目了', '总结这篇文章']) assert.equal(explicitConcernDirective(text), false, text)
})

test('explicit concerns save directly, support multiple subjects and preserve memory permissions', async () => {
  let tool, enabled = true
  const calls = []
  const ctx = { tools: { register(value) { tool = value; return () => {} } }, agents: { list: () => [] }, on: () => () => {} }
  const store = { snapshot: () => ({ sessions: [{ sessionId: 's', companionId: 'c', channelId: 'web', userId: 'u' }], companions: [{ id: 'c', automation: { memory: { enabled } } }] }) }
  const concerns = { async ingestCandidates(...args) { calls.push(args); return { entries: [{ decision: 'created', subject: args[2][0].subject, concern: { id: 'saved' } }] } } }
  const dispose = registerPartnerConcernTool(ctx, store, concerns)
  const evidence = '帮我关注项目 A 和项目 B 的版本变化'
  const agent = { session: { id: 's', snapshotEvents: () => [{ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: evidence }] } }] } }
  const input = { subject: '项目 A 版本变化', reason: '用户要求持续留意更新', evidence, watchKind: 'web', watchQuery: '版本更新', priority: .8, confidence: 1 }
  try {
    const first = JSON.parse(await tool.execute(input, { agent }))
    assert.equal(first.concernId, 'saved')
    assert.equal(first.destination, '在意的事')
    await tool.execute({ ...input, subject: '项目 B 版本变化' }, { agent })
    assert.deepEqual(calls.map(args => args[3]), ['explicit', 'explicit'])
    enabled = false
    await assert.rejects(tool.execute(input, { agent }), /不要改用定时任务/)
    assert.equal(calls.length, 2)
  } finally { dispose() }
})
