import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { normalizeAutomation, normalizeCompanionDraft } from '../lib/domain.js'
import { PartnerAgentRuntime, canReuseSession, completedTurnEvents, partnerCwd, renewedSession, renderToolProtocol, resolveAgentOptions } from '../lib/agent-runtime.js'
import { PartnerStore } from '../lib/store.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { parseDailyReview, parseReflection } from '../lib/memory-reflection.js'
import { localDay, nextAllowedTime, nextDay, quiet } from '../lib/heartbeat.js'

test('evaluates heartbeat schedules in the configured timezone', () => {
  const morning = Date.parse('2026-08-25T01:30:00.000Z') // 09:30 in Shanghai
  const night = Date.parse('2026-08-25T15:30:00.000Z') // 23:30 in Shanghai
  assert.equal(quiet(morning, 22, 8, 'Asia/Shanghai'), false)
  assert.equal(quiet(night, 22, 8, 'Asia/Shanghai'), true)
  assert.equal(new Date(nextAllowedTime(night, 8, 'Asia/Shanghai')).toISOString(), '2026-08-26T00:00:00.000Z')
  assert.equal(new Date(nextDay(morning, 8, 'Asia/Shanghai')).toISOString(), '2026-08-26T00:00:00.000Z')
  assert.equal(localDay(Date.parse('2026-08-25T16:30:00.000Z'), 'Asia/Shanghai'), '2026-08-26')
})

test('normalizes a companion without leaking empty route fields', () => {
  assert.deepEqual(normalizeCompanionDraft({
    name: ' 墨伴 ', role: '工作伙伴', description: '', instructions: '',
    presetId: '', provider: '', model: '', capabilities: ['knowledge', 'knowledge', 'ssh'],
  }), {
    name: '墨伴', role: '工作伙伴', description: '', instructions: '', capabilities: ['knowledge', 'ssh'],
  })
})

test('rejects unknown capabilities', () => {
  assert.deepEqual(normalizeCompanionDraft({ name: '墨伴', capabilities: ['knowledge', 'root-access'] }).capabilities, ['knowledge'])
})

test('inherits the DSH default model and permits explicit companion overrides', () => {
  const defaults = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }) }
  const companion = {
    id: 'companion-1', name: '墨伴', role: '工作伙伴', description: '', instructions: '', presetId: '',
    capabilities: [], createdAt: 1, updatedAt: 1,
  }
  assert.deepEqual(resolveAgentOptions(defaults, companion), {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium',
  })
  assert.deepEqual(resolveAgentOptions(defaults, { ...companion, provider: 'custom', model: 'custom-model' }), {
    provider: 'custom', model: 'custom-model', reasoningEffort: 'medium',
  })
})

test('reloading companion configuration preserves its session routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-'))
  try {
    const store = await PartnerStore.open(join(directory, 'state.json'))
    const companion = store.snapshot().companions[0]
    await store.update(state => state.sessions.push({
      id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: companion.id,
      sessionId: 'session-1', lastMessageAt: 1,
    }))
    const runtime = new PartnerAgentRuntime({}, store, '/home/node')
    await runtime.reloadCompanion(companion.id)
    assert.equal(store.snapshot().sessions[0]?.sessionId, 'session-1')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an archived channel session starts a new conversation on the next message', () => {
  const route = {
    id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: 'companion-1',
    sessionId: 'session-1', lastMessageAt: 1,
  }
  assert.equal(canReuseSession(route, 'companion-1', []), true)
  assert.equal(canReuseSession(route, 'companion-1', ['session-1']), false)
})

test('renewing an archived route preserves its contact scope with a fresh conversation', () => {
  const previous = {
    id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: 'companion-1',
    sessionId: 'session-1', cwd: '/home/node/partners/companion-1', lastMessageAt: 1,
  }
  const next = renewedSession(previous, 42)
  assert.notEqual(next.id, previous.id)
  assert.notEqual(next.sessionId, previous.sessionId)
  assert.equal(next.channelId, previous.channelId)
  assert.equal(next.userId, previous.userId)
  assert.equal(next.companionId, previous.companionId)
  assert.equal(next.cwd, previous.cwd)
  assert.equal(next.lastMessageAt, 42)
})

test('assigns each companion an isolated working directory', () => {
  assert.equal(partnerCwd('/home/node', 'companion-a'), '/home/node/partners/companion-a')
  assert.notEqual(partnerCwd('/home/node', 'companion-a'), partnerCwd('/home/node', 'companion-b'))
})

test('instructs code-mode companions to route SDK tools through run_code', () => {
  const protocol = renderToolProtocol()
  assert.match(protocol, /only `run_code` is callable directly/)
  assert.match(protocol, /await tools\.web_search/)
  assert.match(protocol, /绝不要直接发起名为 `web_search` 的顶层工具调用/)
  assert.match(protocol, /立即在同一轮改用 `run_code` 重试/)
})

test('collects user messages from a completed turn by event boundaries', () => {
  const events = [
    { type: 'turn/start', seq: 10, time: 1, data: { turn: 3 } },
    { type: 'user/message', seq: 11, time: 2, data: { content: [{ type: 'text', text: '请记住这个事项' }], source: { kind: 'user' } } },
    { type: 'step/start', seq: 12, time: 3, data: { turn: 3, step: 1 } },
    { type: 'assistant/message', seq: 13, time: 4, data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已经记住' }] } } },
    { type: 'step/end', seq: 14, time: 5, data: { turn: 3, step: 1 } },
    { type: 'turn/end', seq: 15, time: 6, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
  const turn = completedTurnEvents(events, events.at(-1))
  assert.deepEqual(turn.map(event => event.type), ['user/message', 'step/start', 'assistant/message', 'step/end'])
  assert.equal(turn[0].data.content[0].text, '请记住这个事项')
})

test('validates bounded memory and heartbeat settings', () => {
  assert.deepEqual(normalizeAutomation({
    memory: { enabled: true, retentionDays: 0, dailyReviewEnabled: true, dailyReviewHour: 2 },
    heartbeat: { enabled: true, intervalMinutes: 180, quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 },
  }), {
    memory: { enabled: true, retentionDays: 0, dailyReviewEnabled: true, dailyReviewHour: 2 },
    heartbeat: { enabled: true, intervalMinutes: 180, quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 },
  })
  assert.throws(() => normalizeAutomation({
    memory: { enabled: true, retentionDays: 1 },
    heartbeat: { enabled: true, intervalMinutes: 10, quietStartHour: 22, quietEndHour: 8, dailyLimit: 99 },
  }), /out of range/)
})

test('migrates schema v1 state with safe automation defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-migration-'))
  const path = join(directory, 'state.json')
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      companions: [{ id: 'companion-old', name: '旧伙伴', role: '伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1 }],
      channels: [], pairings: [], sessions: [], recentReceipts: [],
    }))
    const state = (await PartnerStore.open(path)).snapshot()
    assert.equal(state.schemaVersion, 7)
    assert.equal(state.companions[0].automation.memory.enabled, true)
    assert.equal(state.companions[0].automation.heartbeat.enabled, false)
    assert.equal(state.companions[0].automation.memory.retentionDays, 0)
    assert.deepEqual(state.heartbeatStates, [])
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 7)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('archives, consolidates and recalls memory in isolated contact scopes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-memory-'))
  try {
    const memory = new PartnerMemoryStore(directory)
    const turn = { id: 'turn-1', companionId: 'companion-1', scopeId: 'channel-1:user-a', sessionId: 'session-1', at: Date.parse('2026-08-25T08:00:00Z'), user: '不要打补丁', assistant: '明白' }
    await memory.archive(turn)
    await memory.consolidate(turn, {
      daily: { summary: '确认代码修改原则', events: [], openTasks: [], completedTasks: [], learnings: ['拒绝补丁式修改'] },
      memories: [{ kind: 'preference', subject: '代码修改方式', content: '要求从架构解决，不接受补丁式覆盖', confidence: .96, importance: .9, operation: 'upsert' }],
    })
    assert.equal((await memory.recall('companion-1', 'channel-1:user-a', '代码补丁'))[0]?.subject, '代码修改方式')
    assert.deepEqual(await memory.recall('companion-1', 'channel-1:user-b', '代码补丁'), [])
    assert.equal((await memory.recentReflectionsForScope('companion-1', 'channel-1:user-a'))[0]?.turnCount, 1)
    const stored = (await memory.recentMemories('companion-1'))[0]
    const corrected = await memory.updateMemory('companion-1', stored.id, '代码修改原则', '必须先定位根因并统一架构')
    assert.equal(corrected.locked, true)
    assert.equal(corrected.confidence, 1)
    await memory.deleteMemory('companion-1', stored.id)
    assert.deepEqual(await memory.recentMemories('companion-1'), [])
    await memory.clear('companion-1')
    assert.deepEqual(await memory.recentMemories('companion-1'), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates structured JSON memory into SQLite exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-sqlite-migration-'))
  try {
    const companionId = 'companion-legacy'
    const scopeId = 'wechat:user-legacy'
    const hash = createHash('sha256').update(scopeId).digest('hex').slice(0, 24)
    const scope = join(directory, 'partners', companionId, 'memory', 'scopes', hash)
    await mkdir(join(scope, 'diary'), { recursive: true })
    const memory = { id: 'memory-legacy', companionId, scopeId, kind: 'preference', subject: '界面偏好', content: '偏好克制的冷灰配色', status: 'active', confidence: .9, importance: .8, createdAt: 1, updatedAt: 2, evidence: [] }
    const reflection = { date: '2026-08-24', companionId, scopeId, summary: '确认界面方向', events: [], openTasks: [], completedTasks: [], learnings: ['冷灰配色'], updatedAt: 3, turnCount: 2 }
    await writeFile(join(scope, 'memories.json'), JSON.stringify({ schemaVersion: 1, memories: [memory] }))
    await writeFile(join(scope, 'diary', '2026-08-24.json'), JSON.stringify(reflection))
    const store = new PartnerMemoryStore(directory)
    assert.equal(await store.migrateLegacy(companionId), 2)
    assert.equal((await store.recentMemories(companionId))[0]?.id, memory.id)
    assert.equal((await store.recentReflections(companionId))[0]?.date, reflection.date)
    assert.equal(await store.migrateLegacy(companionId), 0)
    assert.equal((await store.recentMemories(companionId)).length, 1)
    await readFile(join(directory, 'partners', companionId, 'memory', 'memory.sqlite'))
    await readFile(join(directory, 'partners', companionId, 'memory', 'legacy-json', hash, 'memories.json'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('finalizes one daily review once and persists evidence-backed relations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-daily-review-'))
  try {
    const store = new PartnerMemoryStore(directory)
    const turn = { id: 'turn-review', companionId: 'companion-review', scopeId: 'wechat:user', sessionId: 'session-review', at: Date.parse('2026-08-25T08:00:00Z'), user: '继续完成主题设计', assistant: '开始处理' }
    await store.archive(turn)
    await store.consolidate(turn, { daily: { summary: '开始主题设计', events: [], openTasks: ['完成主题设计'], completedTasks: [], learnings: [] }, memories: [
      { kind: 'preference', subject: '设计原则', content: '保持统一', confidence: .9, importance: .8, operation: 'upsert' },
      { kind: 'task', subject: '主题设计', content: '完成主题设计', confidence: .9, importance: .9, operation: 'upsert' },
    ] })
    const [target] = await store.pendingDailyReviews(turn.companionId, '2026-08-25')
    assert.ok(target)
    await store.completeDailyReview(target, { daily: { summary: '确认设计原则并推进主题设计', events: [], openTasks: ['完成主题设计'], completedTasks: [], learnings: ['保持统一'] }, memories: [], relations: [
      { sourceSubject: '主题设计', targetSubject: '设计原则', kind: 'depends_on', label: '任务遵循设计原则', confidence: .94 },
    ] })
    assert.deepEqual(await store.pendingDailyReviews(turn.companionId, '2026-08-25'), [])
    const graph = await store.relations(turn.companionId)
    assert.equal(graph.memories.length, 2)
    assert.equal(graph.relations[0]?.kind, 'depends_on')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('validates structured reflection output and gives emotion a bounded lifetime', () => {
  const result = parseReflection(JSON.stringify({
    daily: { summary: '今天确认了主题方向', events: ['选择深空灰'], openTasks: [], completedTasks: [], learnings: ['偏好低对比渐变'] },
    memories: [{ kind: 'emotion', subject: '当前体验', content: '对反复修改感到不耐烦', confidence: .8, importance: .5, operation: 'upsert', expiresInDays: 30 }],
  }))
  assert.equal(result.memories[0].expiresInDays, 7)
  assert.equal(result.daily.learnings[0], '偏好低对比渐变')
})

test('validates daily review relation output', () => {
  const result = parseDailyReview(JSON.stringify({ daily: { summary: '终审', events: [], openTasks: [], completedTasks: [], learnings: [] }, memories: [], relations: [
    { sourceSubject: '主题设计', targetSubject: '设计原则', kind: 'depends_on', label: '遵循', confidence: 1.4 },
    { sourceSubject: '无效', targetSubject: '关系', kind: 'invented', label: '', confidence: 1 },
  ] }))
  assert.equal(result.relations.length, 1)
  assert.equal(result.relations[0].confidence, 1)
})

test('migrates the former 90-day journal default to permanent retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-v2-'))
  const path = join(directory, 'state.json')
  try {
    const companion = {
      id: 'companion-v2', name: '伙伴', role: '伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1,
      automation: { journal: { enabled: true, retentionDays: 90 }, heartbeat: { enabled: false, intervalMinutes: 360, quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 } },
    }
    await writeFile(path, JSON.stringify({ schemaVersion: 2, companions: [companion], channels: [], pairings: [], sessions: [], recentReceipts: [], heartbeatStates: [] }))
    const state = (await PartnerStore.open(path)).snapshot()
    assert.equal(state.schemaVersion, 7)
    assert.equal(state.companions[0].automation.memory.retentionDays, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates the former daily heartbeat cap to unlimited', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-v3-'))
  const path = join(directory, 'state.json')
  try {
    const companion = {
      id: 'companion-v3', name: '伙伴', role: '伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1,
      automation: { journal: { enabled: true, retentionDays: 0 }, heartbeat: { enabled: false, intervalMinutes: 360, quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 } },
    }
    await writeFile(path, JSON.stringify({ schemaVersion: 3, companions: [companion], channels: [], pairings: [], sessions: [], recentReceipts: [], heartbeatStates: [] }))
    const state = (await PartnerStore.open(path)).snapshot()
    assert.equal(state.schemaVersion, 7)
    assert.equal(state.companions[0].automation.heartbeat.dailyLimit, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
