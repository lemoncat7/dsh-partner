import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiveWeixinMedia } from '../lib/channels/weixin/media.js'
import { answerQuestions, busyEnterMode, extractText, isAutonomousDeliveryTurn, renderQuestions } from '../lib/channels/manager.js'
import { extractOutboundAttachments, selectTaskNotificationRoute } from '../lib/agent-runtime.js'
import { CONCERN_CREATED_NOTICE, concernCreatedNoticeFromEvent } from '../lib/concern-notification.js'
import { parseTaskExecutionOutput, prepareTaskResultDelivery } from '../lib/tasks/result.js'

function encrypt(value, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(value), cipher.final()])
}

test('routes completed autonomous goals without mirroring ordinary plugin notices', () => {
  const goal = { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice', summary: 'complete: finished' } } }
  const heartbeat = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴正在进行低打扰心跳检查' } } }
  const taskReview = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务待验收' } } }
  const taskDone = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务已完成' } } }
  const taskBlocked = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务受阻' } } }
  assert.equal(isAutonomousDeliveryTurn([goal]), true)
  assert.equal(isAutonomousDeliveryTurn([taskReview]), false)
  assert.equal(isAutonomousDeliveryTurn([taskDone]), false)
  assert.equal(isAutonomousDeliveryTurn([taskBlocked]), false)
  assert.equal(isAutonomousDeliveryTurn([heartbeat]), false)
})

test('renders short terminal results directly without internal review handoff', async () => {
  const base = {
    id: 'task-1', title: '调研方案', description: '', priority: 'normal', assigneeCompanionId: 'worker', createdBy: 'companion',
    creatorCompanionId: 'creator', skillIds: [], dependencyTaskIds: [], revision: 4, createdAt: 1, updatedAt: 2,
  }
  const done = await prepareTaskResultDelivery({ ...base, status: 'done', resultSummary: '结论与来源都在这里', reviewHandoff: '只给验收者', reviewSummary: '证据完整，验收通过' }, '/tmp')
  assert.match(done.text, /执行结果：\n结论与来源都在这里/)
  assert.match(done.text, /验收结论：证据完整，验收通过/)
  assert.doesNotMatch(done.text, /只给验收者/)
  const blocked = await prepareTaskResultDelivery({ ...base, status: 'blocked', resultSummary: '缺少访问权限' }, '/tmp')
  assert.match(blocked.text, /阻塞说明：\n缺少访问权限/)
})

test('separates review handoff and writes long deliverables to a private Markdown file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-result-')); t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = parseTaskExecutionOutput('<partner-summary>\n短结论\n</partner-summary>\n<partner-deliverable>\n完整交付\n</partner-deliverable>\n<partner-review-handoff>\n请核对来源 A\n</partner-review-handoff>')
  assert.deepEqual(parsed, { summary: '短结论', deliverable: '完整交付', reviewHandoff: '请核对来源 A' })
  const legacy = parseTaskExecutionOutput('## 产出\n最终内容\n\n## 需要验收的内容\n请检查格式')
  assert.deepEqual(legacy, { deliverable: '## 产出\n最终内容', reviewHandoff: '请检查格式' })
  const long = '这是完整交付内容。'.repeat(300)
  const delivery = await prepareTaskResultDelivery({
    id: 'task-long-result', title: '超长调研', description: '', status: 'done', priority: 'normal', createdBy: 'companion',
    creatorCompanionId: 'creator', skillIds: [], dependencyTaskIds: [], resultAbstract: '调研已完成，详见附件。', resultSummary: long,
    reviewHandoff: '内部核验清单', revision: 2, createdAt: 1, updatedAt: 2,
  }, root)
  assert.match(delivery.text, /结论：调研已完成，详见附件/)
  assert.match(delivery.text, /完整交付文档/)
  assert.doesNotMatch(delivery.text, /内部核验清单/)
  assert.ok(delivery.documentPath)
  const document = await readFile(delivery.documentPath, 'utf8')
  assert.match(document, /这是完整交付内容/)
  assert.doesNotMatch(document, /内部核验清单/)
  const attachments = await extractOutboundAttachments(delivery.text, root)
  assert.deepEqual(attachments.map(item => ({ name: item.name, kind: item.kind, mediaType: item.mediaType })), [{
    name: delivery.documentPath.split('/').at(-1), kind: 'file', mediaType: 'text/markdown',
  }])
})

test('task notifications preserve their original channel and prefer another channel over local fallback', () => {
  const routes = [
    { id: 'local', kind: 'local', sessionId: 'session-local', channelId: '@local', userId: 'owner', companionId: 'companion-default', lastMessageAt: 300 },
    { id: 'old-channel', kind: 'channel', sessionId: 'session-old', channelId: 'weixin-1', userId: 'user', companionId: 'companion-default', lastMessageAt: 100 },
    { id: 'new-channel', kind: 'channel', sessionId: 'session-new', channelId: 'weixin-1', userId: 'user', companionId: 'companion-default', lastMessageAt: 200 },
  ]
  assert.equal(selectTaskNotificationRoute(routes, 'session-old', () => false)?.id, 'old-channel')
  assert.equal(selectTaskNotificationRoute(routes, 'missing', () => false)?.id, 'new-channel')
  assert.equal(selectTaskNotificationRoute(routes, 'session-old', route => route.id === 'old-channel')?.id, 'new-channel')
})

test('recognizes automatic concern creation notices for the current channel', () => {
  const event = {
    type: 'user/message', seq: 12, time: 100,
    data: {
      content: [{ type: 'text', text: '伙伴刚刚自动新增了 1 条关注' }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: CONCERN_CREATED_NOTICE },
    },
  }
  assert.equal(concernCreatedNoticeFromEvent(event), '伙伴刚刚自动新增了 1 条关注')
  assert.equal(concernCreatedNoticeFromEvent({ ...event, data: { ...event.data, source: { ...event.data.source, summary: '其他通知' } } }), undefined)
})

async function withFetch(handler, run) {
  const previous = globalThis.fetch
  globalThis.fetch = handler
  try { await run() } finally { globalThis.fetch = previous }
}

test('downloads and decrypts WeChat images with a raw base64 AES key', async () => {
  const key = randomBytes(16)
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('test-image')])
  const encrypted = encrypt(image, key)
  await withFetch(async url => {
    assert.match(String(url), /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download/)
    return new Response(encrypted, { status: 200, headers: { 'content-length': String(encrypted.length) } })
  }, async () => {
    const attachment = await receiveWeixinMedia({
      type: 2,
      image_item: { media: { encrypt_query_param: 'image-token', aes_key: key.toString('base64') } },
    })
    assert.equal(attachment?.kind, 'image')
    assert.equal(attachment?.name, '微信图片.png')
    assert.equal(attachment?.mediaType, 'image/png')
    assert.deepEqual(Buffer.from(attachment?.data ?? []), image)
  })
})

test('downloads and decrypts WeChat files with a base64-encoded hex AES key', async () => {
  const key = randomBytes(16)
  const file = Buffer.from('partner document')
  const encrypted = encrypt(file, key)
  await withFetch(async () => new Response(encrypted, { status: 200 }), async () => {
    const attachment = await receiveWeixinMedia({
      type: 4,
      file_item: {
        file_name: '../工作说明.md',
        content_type: 'text/markdown',
        media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=1', aes_key: Buffer.from(key.toString('hex')).toString('base64') },
      },
    })
    assert.equal(attachment?.kind, 'file')
    assert.equal(attachment?.name, '_工作说明.md')
    assert.equal(attachment?.mediaType, 'text/markdown')
    assert.deepEqual(Buffer.from(attachment?.data ?? []), file)
  })
})

test('rejects media URLs outside trusted WeChat domains before fetching', async () => {
  let called = false
  await withFetch(async () => { called = true; return new Response() }, async () => {
    await assert.rejects(
      receiveWeixinMedia({ type: 4, file_item: { media: { full_url: 'https://example.com/private.pdf' } } }),
      /下载地址不可信/,
    )
  })
  assert.equal(called, false)
})

test('extracts text and voice transcripts without media placeholder text', () => {
  assert.equal(extractText([
    { type: 1, text_item: { text: ' 文字消息 ' } },
    { type: 2, image_item: {} },
    { type: 3, voice_item: { text: '语音转写' } },
    { type: 4, file_item: { file_name: '资料.pdf' } },
  ]), '文字消息\n\n语音转写')
})

test('only exposes supported real files inside the companion workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-partner-media-'))
  const root = join(base, 'partner')
  const outside = join(base, 'outside.pdf')
  try {
    await mkdir(root)
    const image = join(root, '结果图.png')
    const document = join(root, '报告.pdf')
    const unsupported = join(root, '程序.exe')
    const escaped = join(root, 'escape.pdf')
    await writeFile(image, 'png')
    await writeFile(document, 'pdf')
    await writeFile(unsupported, 'exe')
    await writeFile(outside, 'outside')
    await symlink(outside, escaped)
    const result = await extractOutboundAttachments([
      `[图片](${image})`,
      `[报告](<${document}>)`,
      '`结果图.png`',
      unsupported,
      outside,
      escaped,
    ].join('\n'), root)
    assert.deepEqual(result.map(item => ({ name: item.name, kind: item.kind })), [
      { name: '结果图.png', kind: 'image' },
      { name: '报告.pdf', kind: 'file' },
    ])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('resolves a generated relative attachment named in inline code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-relative-media-'))
  try {
    await writeFile(join(root, 'AI资讯汇总.pptx'), 'presentation')
    const result = await extractOutboundAttachments('做好了：`AI资讯汇总.pptx`', root)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.name, 'AI资讯汇总.pptx')
    assert.equal(result[0]?.kind, 'file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renders and parses DSH questions for a text-only channel', () => {
  const questions = [{
    id: 'mode', header: '运行方式', question: '选择执行方式',
    options: [{ label: '继续', description: '执行当前方案' }, { label: '取消' }],
  }, {
    id: 'targets', question: '选择目标', multiSelect: true,
    options: [{ label: '图片' }, { label: '文档' }, { label: '消息' }],
  }]
  assert.match(renderQuestions(questions), /1\. 继续 — 执行当前方案/)
  assert.match(renderQuestions(questions), /分号分隔/)
  assert.deepEqual(answerQuestions(questions, '1；1,3'), { answers: [
    { id: 'mode', selected: ['继续'] },
    { id: 'targets', selected: ['图片', '消息'] },
  ] })
  assert.deepEqual(answerQuestions([questions[0]], '换一种方式'), { answers: [
    { id: 'mode', selected: [], custom: '换一种方式' },
  ] })
})

test('adopts the global busy-enter preference with a queue-safe fallback', () => {
  assert.equal(busyEnterMode({ get: () => ({ busyEnter: 'steer' }) }), 'steer')
  assert.equal(busyEnterMode({ get: () => ({ busyEnter: 'queue' }) }), 'queue')
  assert.equal(busyEnterMode({ get: () => undefined }), 'queue')
})
