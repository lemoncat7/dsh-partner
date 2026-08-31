import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { normalizeAutomation, normalizeCompanionDraft } from '../lib/domain.js'
import { PartnerAgentRuntime, canReuseSession, completedTurnEvents, heartbeatToolDenial, heartbeatToolPolicy, parseConcernObservations, partnerCwd, renewedSession, renderHeartbeatActivity, renderMemory, renderToolProtocol, resolveAgentOptions } from '../lib/agent-runtime.js'
import { PartnerStore } from '../lib/store.js'
import { PartnerMemoryStore } from '../lib/memory-store.js'
import { PartnerConcernStore } from '../lib/concern-store.js'
import { boundedConcernCheckMinutes, concernDecay, concernInterval, concernLifecycleRequest, concernSubjectSimilarity, extractConcernResources, implicitConcernRejection, interruptDecision, normalizeConcernSubject, selectConcernLifecycleTarget } from '../lib/concern-domain.js'
import { applyConcernToolVisibility, validateConcernSuggestion } from '../lib/concern-tool.js'
import { explicitConcernDirective, parseDailyReview, parseReflection, protectConcernDirective } from '../lib/memory-reflection.js'
import { HeartbeatScheduler, heartbeatRetryAt, localDay, nextAllowedTime, nextDay, quiet } from '../lib/heartbeat.js'
import { concernObservationPrompt } from '../lib/autonomy.js'
import { futureTime } from '../lib/time-format.js'
import { renderConcernCreatedNotice } from '../lib/concern-notification.js'
import { authorizeHeartbeatCommand } from '../lib/heartbeat-command.js'

const concern = (overrides = {}) => ({
  id: 'concern-1', companionId: 'companion-1', scopeId: 'weixin:user', subject: 'Canvas 拖动稳定性', reason: '修改后仍然不稳定',
  origin: 'implicit', state: 'watching', priority: .8, confidence: .8, score: .8, watchKind: 'workspace', watchQuery: 'Canvas 拖动相关变化',
  createdAt: 1, updatedAt: 1, lastActivityAt: 1, nextCheckAt: 1, ...overrides,
})

test('evaluates heartbeat schedules in the configured timezone', () => {
  const morning = Date.parse('2026-08-25T01:30:00.000Z')
  const night = Date.parse('2026-08-25T15:30:00.000Z')
  assert.equal(quiet(morning, 22, 8, 'Asia/Shanghai'), false)
  assert.equal(quiet(night, 22, 8, 'Asia/Shanghai'), true)
  assert.equal(new Date(nextAllowedTime(night, 8, 'Asia/Shanghai')).toISOString(), '2026-08-26T00:00:00.000Z')
  assert.equal(new Date(nextDay(morning, 8, 'Asia/Shanghai')).toISOString(), '2026-08-26T00:00:00.000Z')
  assert.equal(localDay(Date.parse('2026-08-25T16:30:00.000Z'), 'Asia/Shanghai'), '2026-08-26')
})

test('normalizes companions, capabilities and optional model routes', () => {
  assert.deepEqual(normalizeCompanionDraft({
    name: ' 墨伴 ', role: '工作伙伴', description: '', instructions: '', presetId: '', provider: '', model: '',
    capabilities: ['knowledge', 'knowledge', 'ssh', 'root-access'],
  }), { name: '墨伴', role: '工作伙伴', description: '', instructions: '', capabilities: ['knowledge', 'ssh'] })
})

test('inherits the DSH default model and permits companion overrides', () => {
  const defaults = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }) }
  const companion = { id: 'companion-1', name: '墨伴', role: '工作伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1 }
  assert.deepEqual(resolveAgentOptions(defaults, companion), { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' })
  assert.deepEqual(resolveAgentOptions(defaults, { ...companion, provider: 'custom', model: 'custom-model' }), { provider: 'custom', model: 'custom-model', reasoningEffort: 'medium' })
})

test('preserves and renews isolated companion sessions correctly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-'))
  try {
    const store = await PartnerStore.open(join(directory, 'state.json'))
    const companion = store.snapshot().companions[0]
    const route = { id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: companion.id, sessionId: 'session-1', cwd: '/home/node/partners/a', lastMessageAt: 1 }
    await store.update(state => state.sessions.push(route))
    await new PartnerAgentRuntime({}, store, '/home/node').reloadCompanion(companion.id)
    assert.equal(store.snapshot().sessions[0]?.sessionId, 'session-1')
    assert.equal(canReuseSession(route, companion.id, []), true)
    assert.equal(canReuseSession(route, companion.id, ['session-1']), false)
    const renewed = renewedSession(route, 42)
    assert.notEqual(renewed.sessionId, route.sessionId)
    assert.equal(renewed.userId, route.userId)
    assert.equal(renewed.cwd, route.cwd)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('assigns each companion an isolated working directory', () => {
  assert.equal(partnerCwd('/home/node', 'companion-a'), '/home/node/partners/companion-a')
  assert.notEqual(partnerCwd('/home/node', 'companion-a'), partnerCwd('/home/node', 'companion-b'))
})

test('instructs code-mode companions to route SDK tools through run_code', () => {
  const protocol = renderToolProtocol()
  assert.match(protocol, /only `run_code` is callable directly/)
  assert.match(protocol, /await tools\.web_search/)
  assert.match(protocol, /立即在同一轮改用 `run_code` 重试/)
})

test('renders relation evidence and guards conflicting memories from silent merging', () => {
  const source = { id: 'memory-a', companionId: 'companion-1', scopeId: 'weixin:user', kind: 'preference', subject: '发布方式', content: '先预览再发布', status: 'active', confidence: .9, importance: .8, createdAt: 1, updatedAt: 1, evidence: [] }
  const target = { ...source, id: 'memory-b', kind: 'event', subject: '发布指令', content: '直接发布' }
  const relation = { id: 'relation-1', companionId: 'companion-1', scopeId: 'weixin:user', sourceMemoryId: source.id, targetMemoryId: target.id, kind: 'conflicts_with', label: '发布时机尚未确认', confidence: .91, updatedAt: 2 }
  const prompt = renderMemory([source, target], [{ relation, source, target }])
  assert.match(prompt, /发布方式 冲突 发布指令/)
  assert.match(prompt, /不得自行选择一方/)
  assert.match(prompt, /请用户确认/)
})

test('frames heartbeat as bounded concern change observation', () => {
  const prompt = concernObservationPrompt([
    concern({ id: 'concern-local', resources: [{ kind: 'file', locator: 'docs/status.md', label: 'docs/status.md' }] }),
    concern({ id: 'concern-web', scopeId: '*', subject: 'DSH 版本发布', reason: '等待修复', origin: 'explicit', watchKind: 'web', watchQuery: 'DSH releases' }),
    concern({ id: 'concern-knowledge', scopeId: '*', subject: 'nomifun 版本更新', reason: '等待新版', origin: 'explicit', watchKind: 'knowledge', watchQuery: 'nomifun nomifun-desktop 版本更新', resources: [{ kind: 'knowledge', locator: '项目长期记忆/nomifun/nomifun-desktop 版本更新关注', label: '项目长期记忆 · nomifun/nomifun-desktop 版本更新关注' }] }),
  ], '/home/node/partners/companion-1')
  assert.match(prompt, /伙伴变化观察/)
  assert.match(prompt, /本轮挂念/)
  assert.match(prompt, /Canvas 拖动稳定性/)
  assert.match(prompt, /DSH 版本发布/)
  assert.match(prompt, /逐项判断/)
  assert.match(prompt, /不要把本地项目问题.*无差别丢给网页搜索/)
  assert.match(prompt, /工具可自由组合/)
  assert.match(prompt, /知识库按“确定库 → 库内检索 → 读取准确条目”执行/)
  assert.match(prompt, /是本轮调查的操作约束，不只是背景资料/)
  assert.match(prompt, /需要 HTML 标记、脚本内嵌 JSON.*用 web_source/)
  assert.match(prompt, /web_search 只能用于发现候选，不能替代知识文档明确指定的原始页面/)
  assert.match(prompt, /必须严格采用知识文档约定的失败处理/)
  assert.match(prompt, /resources 已给出 knowledgeBase 时.*直接从 knowledge_search 开始/)
  assert.match(prompt, /"searchQuery":"nomifun nomifun-desktop 版本更新"/)
  assert.match(prompt, /本地目录按“确定范围 → 找到候选文件或命中位置 → 读取准确文件”执行/)
  assert.match(prompt, /不要自行拼接库名、动作词“关注\/留意”/)
  assert.match(prompt, /不得读取伙伴记忆、会话归档、日记或 concerns 数据库/)
  assert.match(prompt, /只能更新 resources 中明确列出的现存文件/)
  assert.match(prompt, /\/home\/node\/partners\/companion-1\/docs\/status\.md/)
  assert.match(prompt, /必须调用 heartbeat_local_command/)
  assert.match(prompt, /不要改成 glob、grep 或 read 去猜结果/)
  assert.match(prompt, /不得执行其他命令、发布、提交/)
  assert.match(prompt, /只输出一个 JSON 对象/)
  assert.match(prompt, /nextCheckInMinutes/)
  assert.match(prompt, /notificationRuleEffect/)
  assert.match(prompt, /不能根据普通关注理由自行创造规则/)
  assert.match(prompt, /最少 30 分钟，最多 43200 分钟/)
  assert.match(prompt, /不要让所有挂念机械地使用相同间隔/)
  assert.match(prompt, /是否提醒由确定性策略另行决定/)
  assert.doesNotMatch(prompt, /NO_ACTION|当前会话上下文/)
})

test('authorizes only structured read-only heartbeat commands without a shell', () => {
  assert.deepEqual(authorizeHeartbeatCommand('dsh -V'), { file: 'dsh', args: ['-V'], command: 'dsh -V' })
  assert.deepEqual(authorizeHeartbeatCommand('npm view @deepseek-ai/dsh version'), {
    file: 'npm', args: ['view', '@deepseek-ai/dsh', 'version'], command: 'npm view @deepseek-ai/dsh version',
  })
  assert.deepEqual(authorizeHeartbeatCommand('git status --short --branch'), {
    file: 'git', args: ['status', '--short', '--branch'], command: 'git status --short --branch',
  })
  assert.throws(() => authorizeHeartbeatCommand('dsh -V。'), /allowlist/)
  assert.throws(() => authorizeHeartbeatCommand('dsh -V; rm -rf /'), /metacharacter/)
  assert.throws(() => authorizeHeartbeatCommand('bash -lc "dsh -V"'), /allowlist/)
  assert.throws(() => authorizeHeartbeatCommand('npm exec anything'), /allowlist/)
  assert.throws(() => authorizeHeartbeatCommand('git config --get user.name'), /allowlist/)
})

test('parses and bounds AI-selected concern check intervals', () => {
  const parsed = parseConcernObservations(JSON.stringify({ observations: [
    { concernId: 'a', changed: false, event: '', evidence: '暂无变化', source: 'workspace', relevance: .7, confidence: .8, actionability: .2, nextCheckInMinutes: 5, notificationRuleEffect: 'notify', notificationRuleReason: '高于知识基线时提醒' },
    { concernId: 'b', changed: false, event: '', evidence: '等待发布', source: 'web', relevance: .8, confidence: .8, actionability: .3, nextCheckInMinutes: 90_000 },
    { concernId: 'c', changed: false, event: '', evidence: '', source: '', relevance: .5, confidence: .5, actionability: .5, nextCheckInMinutes: 'tomorrow' },
  ] }), new Set(['a', 'b', 'c']))
  assert.equal(parsed[0]?.nextCheckInMinutes, 30)
  assert.equal(parsed[1]?.nextCheckInMinutes, 43_200)
  assert.equal(parsed[2]?.nextCheckInMinutes, undefined)
  assert.equal(parsed[0]?.notificationRuleEffect, 'notify')
  assert.equal(parsed[0]?.notificationRuleReason, '高于知识基线时提醒')
  assert.equal(boundedConcernCheckMinutes(89.6), 90)
  assert.equal(boundedConcernCheckMinutes(Number.NaN), undefined)
})

test('formats upcoming concern checks without expanding the concern row', () => {
  const now = Date.parse('2026-08-28T00:00:00Z')
  assert.equal(futureTime(now - 1, now), '即将检查')
  assert.equal(futureTime(now + 30 * 60_000, now), '30 分钟后')
  assert.equal(futureTime(now + 3 * 3_600_000, now), '3 小时后')
  assert.equal(futureTime(now + 2 * 86_400_000, now), '2 天后')
})

test('keeps heartbeat filesystem discovery out of partner private stores', () => {
  assert.match(heartbeatToolDenial('read', { file_path: './memory/scopes/contact/conversations/day.jsonl' }), /不能访问长期记忆/)
  assert.match(heartbeatToolDenial('grep', { path: 'memory-backup-before-sqlite/scopes' }), /不能访问长期记忆/)
  assert.match(heartbeatToolDenial('glob', { path: '/home/node/partners/a/memory' }), /不能访问长期记忆/)
  assert.equal(heartbeatToolDenial('read', { file_path: './notes/project.md' }), undefined)
})

test('allows flexible discovery and only exposes file updates for linked files', () => {
  const discovery = ['knowledge_base_search', 'knowledge_search', 'knowledge_read', 'glob', 'grep', 'read', 'web_search', 'web_fetch', 'web_source']
  const tools = [...discovery, 'write', 'edit', 'str_replace_editor']
  const unlinked = heartbeatToolPolicy([concern({ watchKind: 'workspace' })], tools)
  assert.deepEqual([...unlinked.allowed].sort(), [...discovery].sort())

  const linked = heartbeatToolPolicy([concern({ resources: [{ kind: 'file', locator: 'docs/roadmap.md', label: 'docs/roadmap.md' }] })], tools)
  assert.deepEqual([...linked.allowed].sort(), [...tools].sort())
})

test('restricts heartbeat writes to the exact linked existing file', () => {
  const access = { root: '/home/node/partners/a', writable: new Set(['/home/node/partners/a/docs/roadmap.md']) }
  assert.equal(heartbeatToolDenial('edit', { file_path: 'docs/roadmap.md', old_string: 'a', new_string: 'b' }, access), undefined)
  assert.equal(heartbeatToolDenial('write', { file_path: '/home/node/partners/a/docs/roadmap.md', content: 'new' }, access), undefined)
  assert.match(heartbeatToolDenial('edit', { file_path: 'docs/other.md' }, access), /明确关联的现存 @文件/)
  assert.match(heartbeatToolDenial('write', { file_path: '../outside.md' }, access), /当前伙伴工作目录/)
  assert.match(heartbeatToolDenial('write', { file_path: 'memory/profile.md' }, access), /不能访问长期记忆/)
  assert.match(heartbeatToolDenial('str_replace_editor', { command: 'create', path: 'docs/roadmap.md' }, access), /不能创建新文件/)
})

test('extracts safe file and knowledge references and recognizes explicit concern language', () => {
  assert.deepEqual(extractConcernResources('帮我留意 @docs/roadmap.md 和 @"notes/design rules.md"，参考 @知识库[DSH/主题设计规范]'), [
    { kind: 'knowledge', locator: 'DSH/主题设计规范', label: 'DSH · 主题设计规范' },
    { kind: 'file', locator: 'docs/roadmap.md', label: 'docs/roadmap.md' },
    { kind: 'file', locator: 'notes/design rules.md', label: 'notes/design rules.md' },
  ])
  assert.deepEqual(extractConcernResources('不要读取 @../secret 或 @memory/scopes/private.json'), [])
  assert.equal(explicitConcernDirective('让伙伴帮我关注这个项目的版本变化'), true)
  assert.equal(explicitConcernDirective('不用再关注这个项目了'), false)
})

test('turns an explicit knowledge mention into a focused knowledge concern', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-explicit-reference-'))
  try {
    const store = new PartnerConcernStore(directory)
    const item = await store.createExplicit('companion-1', '*', '@知识库[项目长期记忆/nomifun/nomifun-desktop 版本更新关注]')
    assert.equal(item.subject, 'nomifun/nomifun-desktop 版本更新关注')
    assert.equal(item.watchKind, 'knowledge')
    assert.equal(item.watchQuery, 'nomifun nomifun-desktop 版本更新')
    assert.deepEqual(item.resources, [{ kind: 'knowledge', locator: '项目长期记忆/nomifun/nomifun-desktop 版本更新关注', label: '项目长期记忆 · nomifun/nomifun-desktop 版本更新关注' }])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates a legacy raw knowledge token into a focused concern', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-reference-migration-'))
  try {
    const store = new PartnerConcernStore(directory)
    const created = await store.createExplicit('companion-1', '*', '@知识库[项目长期记忆/nomifun/nomifun-desktop 版本更新关注]')
    const path = join(directory, 'partners', 'companion-1', 'concerns', 'concerns.sqlite')
    const database = new DatabaseSync(path)
    database.prepare("DELETE FROM concern_meta WHERE key = 'reference-subject-normalized-v1'").run()
    const raw = '@知识库[项目长期记忆/nomifun/nomifun-desktop 版本更新关注]'
    database.prepare("UPDATE concerns SET normalized_subject = ?, subject = ?, watch_kind = 'auto', watch_query = ? WHERE id = ?").run(normalizeConcernSubject(raw), raw, raw, created.id)
    database.close()
    const [migrated] = await new PartnerConcernStore(directory).list('companion-1')
    assert.equal(migrated.subject, 'nomifun/nomifun-desktop 版本更新关注')
    assert.equal(migrated.watchKind, 'knowledge')
    assert.equal(migrated.watchQuery, 'nomifun nomifun-desktop 版本更新')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renders compact inspectable heartbeat activity without model reasoning', () => {
  const activity = renderHeartbeatActivity({
    concerns: [concern(), concern({ id: 'concern-2', subject: '依赖更新' })], candidates: [], observations: [],
    startedAt: 1_000, completedAt: 3_500, output: '{"observations":[]}', tools: [{
      name: 'knowledge_search', input: '{"query":"待关注事项"}', output: '没有找到新变化', startedAt: 1_200, completedAt: 2_000, status: 'completed',
    }],
  }, 'quiet')
  assert.match(activity, /状态：无需主动提醒/)
  assert.match(activity, /本轮挂念：Canvas 拖动稳定性；依赖更新/)
  assert.match(activity, /1\. knowledge_search · 完成 · 800 ms/)
  assert.match(activity, /最终结论：本轮没有发现经过校验的新变化/)
  assert.doesNotMatch(activity, /推理|思维链/)
})

test('uses deterministic interruption thresholds and explicit decay rules', () => {
  assert.equal(concernInterval(.9, 'explicit'), 3 * 3_600_000 * .75)
  assert.equal(concernDecay(.8, 1, 100_000_000, 'explicit'), .8)
  assert.ok(concernDecay(.8, 1, 100 * 86_400_000, 'implicit') < .18)
  assert.equal(interruptDecision({ priority: .2, concernConfidence: .8, observationConfidence: .3, relevance: .9, novelty: 1, actionability: 1, recentlyMentioned: false, firstObservation: false }).decision, 'drop')
  assert.equal(interruptDecision({ priority: 1, concernConfidence: 1, observationConfidence: 1, relevance: 1, novelty: 1, actionability: 1, recentlyMentioned: false, firstObservation: false }).decision, 'notify')
  assert.notEqual(interruptDecision({ priority: 1, concernConfidence: 1, observationConfidence: 1, relevance: 1, novelty: .5, actionability: 1, recentlyMentioned: false, firstObservation: true }).decision, 'notify')
  assert.equal(interruptDecision({ priority: .7, concernConfidence: .8, observationConfidence: .9, relevance: .9, novelty: .5, actionability: .7, recentlyMentioned: false, firstObservation: true, notificationRuleEffect: 'notify' }).decision, 'notify')
  assert.equal(interruptDecision({ priority: 1, concernConfidence: 1, observationConfidence: 1, relevance: 1, novelty: 1, actionability: 1, recentlyMentioned: false, firstObservation: false, notificationRuleEffect: 'suppress' }).decision, 'feed')
})

test('never retries a failed heartbeat sooner than its configured interval', () => {
  const now = Date.parse('2026-08-28T01:00:00Z')
  assert.equal(heartbeatRetryAt(now, 30, 1), now + 30 * 60_000)
  assert.equal(heartbeatRetryAt(now, 30, 6), now + 64 * 60_000)
  assert.equal(heartbeatRetryAt(now, 30, 20), now + 6 * 3_600_000)
})

test('does not invoke the agent when no concern is due', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-heartbeat-empty-'))
  try {
    const store = await PartnerStore.open(join(directory, 'state.json'))
    const companion = store.snapshot().companions[0]
    await store.update(state => {
      state.channels.push({ id: 'weixin-1', companionId: companion.id, accountId: 'account', name: '微信', enabled: true, createdAt: 1, updatedAt: 1 })
      state.pairings.push({ id: 'pairing-1', channelId: 'weixin-1', userId: 'user-1', displayName: '用户', status: 'approved', createdAt: 1, updatedAt: 1 })
      state.sessions.push({ id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: companion.id, sessionId: 'session-1', lastMessageAt: 1 })
    })
    let agentCalls = 0
    let dueOptions
    const scheduler = new HeartbeatScheduler(
      { logger: { warn() {}, error() {} } }, store,
      { heartbeat: async () => { agentCalls += 1; throw new Error('must not run') } },
      { sendProactive: async () => {} },
      { pendingNotifications: async () => [], due: async (_companionId, _scopeId, options) => { dueOptions = options; return [] } },
    )
    const result = await scheduler.trigger(companion.id, { manual: true })
    assert.equal(result.checked, false)
    assert.match(result.reason, /没有到期/)
    assert.equal(agentCalls, 0)
    assert.equal(dueOptions.includeFuture, false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('checks only the selected concern when manually triggered from its row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-heartbeat-target-'))
  try {
    const store = await PartnerStore.open(join(directory, 'state.json'))
    const companion = store.snapshot().companions[0]
    const target = concern({ id: 'concern-target', companionId: companion.id, nextCheckAt: Date.now() + 86_400_000 })
    await store.update(state => {
      state.channels.push({ id: 'weixin-1', companionId: companion.id, accountId: 'account', name: '微信', enabled: true, createdAt: 1, updatedAt: 1 })
      state.pairings.push({ id: 'pairing-1', channelId: 'weixin-1', userId: 'user-1', displayName: '用户', status: 'approved', createdAt: 1, updatedAt: 1 })
      state.sessions.push({ id: 'route-1', channelId: 'weixin-1', userId: 'user-1', companionId: companion.id, sessionId: 'session-1', lastMessageAt: 1 })
    })
    let dueOptions
    let agentConcerns
    const scheduler = new HeartbeatScheduler(
      { logger: { warn() {}, error() {} } }, store,
      {
        heartbeat: async (_companion, _route, concerns) => {
          agentConcerns = concerns
          return { concerns, candidates: [], observations: [], startedAt: 1, completedAt: 2, output: '{"observations":[]}', tools: [] }
        },
        persistKnowledgeObservations: async () => {}, recordHeartbeatActivity: async () => {},
      },
      { sendProactive: async () => {} },
      {
        pendingNotifications: async () => { throw new Error('targeted checks must not flush unrelated notifications') },
        due: async (_companionId, _scopeId, options) => { dueOptions = options; return [target] },
        recordObservations: async () => ({ observations: [], notifications: [] }),
      },
    )
    const result = await scheduler.trigger(companion.id, { manual: true, concernId: target.id })
    assert.equal(result.checked, true)
    assert.equal(result.sent, false)
    assert.deepEqual(dueOptions, { now: dueOptions.now, limit: 1, includeFuture: true, concernId: target.id })
    assert.deepEqual(agentConcerns.map(item => item.id), [target.id])
  } finally { await rm(directory, { recursive: true, force: true }) }
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
  assert.deepEqual(completedTurnEvents(events, events.at(-1)).map(event => event.type), ['user/message', 'step/start', 'assistant/message', 'step/end'])
})

test('validates bounded memory and heartbeat settings without legacy focus runtime', () => {
  const input = {
    memory: { enabled: true, retentionDays: 0, dailyReviewEnabled: true, dailyReviewHour: 2 },
    heartbeat: { enabled: true, intervalMinutes: 180, quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 },
  }
  assert.deepEqual(normalizeAutomation(input), input)
  assert.throws(() => normalizeAutomation({
    memory: { enabled: true, retentionDays: 1 },
    heartbeat: { enabled: true, intervalMinutes: 10, quietStartHour: 22, quietEndHour: 8, dailyLimit: 99 },
  }), /out of range/)
})

test('migrates legacy partner states to schema 10 and preserves focus only as a one-shot seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-migration-'))
  const path = join(directory, 'state.json')
  try {
    const companion = {
      id: 'companion-old', name: '旧伙伴', role: '伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1,
      automation: { memory: { enabled: true, retentionDays: 0, dailyReviewEnabled: true, dailyReviewHour: 2 }, heartbeat: { enabled: true, focus: '项目风险；依赖更新', intervalMinutes: 30, quietStartHour: 22, quietEndHour: 8, dailyLimit: 0 } },
    }
    await writeFile(path, JSON.stringify({ schemaVersion: 9, companions: [companion], channels: [], pairings: [], sessions: [], recentReceipts: [], heartbeatStates: [] }))
    const state = (await PartnerStore.open(path)).snapshot()
    assert.equal(state.schemaVersion, 10)
    assert.equal(state.companions[0].automation.heartbeat.legacyFocus, '项目风险\n依赖更新')
    assert.equal('focus' in state.companions[0].automation.heartbeat, false)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 10)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates schema v1 defaults and obsolete focus cursor through schema 10', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-v1-'))
  const path = join(directory, 'state.json')
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      companions: [{ id: 'old', name: '旧伙伴', role: '伙伴', description: '', instructions: '', capabilities: [], createdAt: 1, updatedAt: 1 }],
      channels: [], pairings: [], sessions: [], recentReceipts: [],
    }))
    const state = (await PartnerStore.open(path)).snapshot()
    assert.equal(state.schemaVersion, 10)
    assert.equal(state.companions[0].automation.memory.retentionDays, 0)
    assert.equal(state.companions[0].automation.heartbeat.enabled, false)
    assert.deepEqual(state.heartbeatStates, [])
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
    assert.equal((await memory.updateMemory('companion-1', stored.id, '代码修改原则', '必须先定位根因')).locked, true)
    await memory.deleteMemory('companion-1', stored.id)
    assert.deepEqual(await memory.recentMemories('companion-1'), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates structured JSON memory into SQLite exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-sqlite-migration-'))
  try {
    const companionId = 'companion-legacy'; const scopeId = 'wechat:user-legacy'
    const hash = createHash('sha256').update(scopeId).digest('hex').slice(0, 24)
    const scope = join(directory, 'partners', companionId, 'memory', 'scopes', hash)
    await mkdir(join(scope, 'diary'), { recursive: true })
    const memory = { id: 'memory-legacy', companionId, scopeId, kind: 'preference', subject: '界面偏好', content: '偏好克制的冷灰配色', status: 'active', confidence: .9, importance: .8, createdAt: 1, updatedAt: 2, evidence: [] }
    const reflection = { date: '2026-08-24', companionId, scopeId, summary: '确认界面方向', events: [], openTasks: [], completedTasks: [], learnings: ['冷灰配色'], updatedAt: 3, turnCount: 2 }
    await writeFile(join(scope, 'memories.json'), JSON.stringify({ schemaVersion: 1, memories: [memory] }))
    await writeFile(join(scope, 'diary', '2026-08-24.json'), JSON.stringify(reflection))
    const store = new PartnerMemoryStore(directory)
    assert.equal(await store.migrateLegacy(companionId), 2)
    assert.equal(await store.migrateLegacy(companionId), 0)
    assert.equal((await store.recentMemories(companionId)).length, 1)
    await readFile(join(directory, 'partners', companionId, 'memory', 'legacy-json', hash, 'memories.json'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('maintains evidence-backed relations incrementally until explicitly removed', async () => {
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
    await store.completeDailyReview(target, { daily: { summary: '确认设计原则并推进主题设计', events: [], openTasks: ['完成主题设计'], completedTasks: [], learnings: ['保持统一'] }, memories: [], concerns: [], relations: [
      { sourceSubject: '主题设计', sourceKind: 'task', targetSubject: '设计原则', targetKind: 'preference', kind: 'depends_on', label: '任务遵循设计原则', confidence: .94, operation: 'upsert' },
      { sourceSubject: '主题设计', sourceKind: 'task', targetSubject: '设计原则', targetKind: 'preference', kind: 'depends_on', label: '重复关系', confidence: .93, operation: 'upsert' },
      { sourceSubject: '设计原则', sourceKind: 'preference', targetSubject: '主题设计', targetKind: 'task', kind: 'supports', label: '置信度不足', confidence: .61, operation: 'upsert' },
    ] })
    assert.deepEqual(await store.pendingDailyReviews(turn.companionId, '2026-08-25'), [])
    const relations = (await store.relations(turn.companionId)).relations
    assert.equal(relations.length, 1)
    assert.equal(relations[0]?.kind, 'depends_on')
    assert.equal((await store.dailyReviewContext(target)).existingRelations.length, 1)
    await store.completeDailyReview(target, { daily: { summary: '关系没有变化', events: [], openTasks: [], completedTasks: [], learnings: [] }, memories: [], concerns: [], relations: [] })
    assert.equal((await store.relations(turn.companionId)).relations.length, 1)
    await store.completeDailyReview(target, { daily: { summary: '关系已经失效', events: [], openTasks: [], completedTasks: [], learnings: [] }, memories: [], concerns: [], relations: [
      { sourceSubject: '主题设计', sourceKind: 'task', targetSubject: '设计原则', targetKind: 'preference', kind: 'depends_on', label: '', confidence: 1, operation: 'remove' },
    ] })
    assert.equal((await store.relations(turn.companionId)).relations.length, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('validates structured reflection concerns and bounded emotion lifetime', () => {
  const result = parseReflection(JSON.stringify({
    daily: { summary: '今天确认了主题方向', events: ['选择深空灰'], openTasks: [], completedTasks: [], learnings: ['偏好低对比渐变'] },
    memories: [{ kind: 'emotion', subject: '当前体验', content: '对反复修改感到不耐烦', confidence: .8, importance: .5, operation: 'upsert', expiresInDays: 30 }],
    concerns: [{ subject: '主题视觉疲劳仍未解决', reason: '用户仍然不满意', confidence: .86, priority: .8, operation: 'upsert', watchKind: 'workspace', watchQuery: '主题视觉实现变化' }],
  }))
  assert.equal(result.memories[0].expiresInDays, 7)
  assert.equal(result.concerns[0]?.subject, '主题视觉疲劳仍未解决')
  assert.equal(result.concerns[0]?.watchKind, 'workspace')
})

test('validates daily review relation output', () => {
  const result = parseDailyReview(JSON.stringify({ daily: { summary: '终审', events: [], openTasks: [], completedTasks: [], learnings: [] }, memories: [], concerns: [], relations: [
    { sourceSubject: '主题设计', sourceKind: 'task', targetSubject: '设计原则', targetKind: 'preference', kind: 'depends_on', label: '遵循', confidence: 1.4 },
    { sourceSubject: '旧任务', sourceKind: 'task', targetSubject: '旧约束', targetKind: 'preference', kind: 'depends_on', label: '', confidence: .5, operation: 'remove' },
    { sourceSubject: '主题设计', targetSubject: '设计原则', kind: 'depends_on', label: '', confidence: .9 },
    { sourceSubject: '无效', targetSubject: '关系', kind: 'invented', label: '', confidence: 1 },
  ] }))
  assert.equal(result.relations.length, 2)
  assert.equal(result.relations[0].confidence, 1)
  assert.equal(result.relations[0].sourceKind, 'task')
  assert.equal(result.relations[0].targetKind, 'preference')
  assert.equal(result.relations[0].operation, 'upsert')
  assert.equal(result.relations[1].operation, 'remove')
})

test('stores concerns by scope, deduplicates observations and defers relevant mentions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concerns-'))
  try {
    const store = new PartnerConcernStore(directory)
    const now = Date.now()
    await store.applyCandidates('companion-1', 'weixin:user-a', [{ subject: 'Canvas 拖动稳定性', reason: '仍未解决', operation: 'upsert', priority: .8, confidence: .8, watchKind: 'workspace', watchQuery: 'Canvas 拖动变化' }], 'implicit', now - 10 * 3_600_000)
    assert.equal((await store.due('companion-1', 'weixin:user-b', { now, limit: 12, includeFuture: true })).length, 0)
    const [target] = await store.due('companion-1', 'weixin:user-a', { now, limit: 12, includeFuture: true })
    const first = await store.recordObservations([target], [{ concernId: target.id, changed: true, event: '拖动控制器有一处新修改', evidence: 'interaction-controller.ts 更新', source: 'workspace', relevance: .7, confidence: .8, actionability: .6, nextCheckInMinutes: 90 }], now)
    assert.equal(first.observations[0]?.decision, 'defer')
    assert.equal((await store.activity('companion-1')).observations[0]?.decision, 'defer')
    assert.equal((await store.list('companion-1', 'weixin:user-a')).find(item => item.id === target.id)?.nextCheckAt, now + 90 * 60_000)
    assert.equal((await store.deferred('companion-1', 'weixin:user-a', 'Canvas 拖动怎么了'))[0]?.id, first.observations[0]?.id)
    assert.equal((await store.recordObservations([target], [{ concernId: target.id, changed: true, event: '拖动控制器有一处新修改', evidence: 'interaction-controller.ts 更新', source: 'workspace', relevance: .7, confidence: .8, actionability: .6, nextCheckInMinutes: 120 }], now + 1)).observations.length, 0)
    assert.equal((await store.list('companion-1', 'weixin:user-a')).find(item => item.id === target.id)?.nextCheckAt, now + 1 + 120 * 60_000)
    const second = await store.recordObservations([target], [{ concernId: target.id, changed: true, event: '新版明确修复拖动丢帧', evidence: '测试与发行说明均已确认', source: 'workspace', relevance: 1, confidence: 1, actionability: 1 }], now + 2)
    assert.equal(second.notifications.length, 1)
    assert.equal((await store.pendingNotifications('companion-1', 'weixin:user-a')).length, 1)
    await store.markMentioned('companion-1', second.notifications.map(item => item.id), now + 3)
    assert.equal((await store.pendingNotifications('companion-1', 'weixin:user-a')).length, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('returns only newly created concerns for automatic creation notices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-created-concerns-'))
  try {
    const store = new PartnerConcernStore(directory)
    const candidate = { subject: '窄窗口遮挡', reason: '问题仍未闭环', operation: 'upsert', priority: .7, confidence: .8, watchKind: 'workspace', watchQuery: '窄窗口遮挡' }
    const created = await store.applyCandidates('companion-1', 'weixin:user', [candidate], 'implicit', 100)
    assert.equal(created.length, 1)
    assert.equal((await store.applyCandidates('companion-1', 'weixin:user', [candidate], 'implicit', 101)).length, 0)
    assert.match(renderConcernCreatedNotice(created), /伙伴刚刚自动新增了 1 条关注/)
    assert.match(renderConcernCreatedNotice(created), /窄窗口遮挡/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('gates, bounds and audits implicit concern candidates through one policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-policy-'))
  try {
    const store = new PartnerConcernStore(directory)
    const weak = { subject: '以后看看', reason: '可能有事', operation: 'upsert', priority: .4, confidence: .6, watchKind: 'auto', watchQuery: '看看' }
    assert.match(implicitConcernRejection(weak) ?? '', /优先级|置信度|综合/)
    const rejected = await store.ingestCandidates('companion-1', 'weixin:user', [weak], 'implicit', 100, {
      source: 'tool', sessionId: 'session-1', evidence: '以后看看', maxImplicitCreates: 1,
    })
    assert.equal(rejected.created.length, 0)
    assert.equal(rejected.entries[0]?.decision, 'rejected')
    assert.equal((await store.list('companion-1')).length, 0)

    const candidates = ['终端输入持续延迟', 'SFTP 目录无法进入', '平板布局仍然越界'].map(subject => ({
      subject, reason: '当前问题尚未闭环', operation: 'upsert', priority: .78, confidence: .86,
      watchKind: 'workspace', watchQuery: `${subject}后续变化`,
    }))
    const accepted = await store.ingestCandidates('companion-1', 'weixin:user', candidates, 'implicit', 101, {
      source: 'reflection', sessionId: 'session-1', evidence: '本轮对话',
    })
    assert.equal(accepted.created.length, 2)
    assert.equal(accepted.entries[2]?.decision, 'rejected')
    assert.match(accepted.entries[2]?.reason ?? '', /最多新增 2 条/)

    const toolResult = await store.ingestCandidates('companion-1', 'weixin:user', [{
      subject: '文件传输偶发丢失目录', reason: '目录传输仍有失败记录', operation: 'upsert', priority: .8, confidence: .9,
      watchKind: 'workspace', watchQuery: '目录传输失败是否复现',
    }], 'implicit', 102, { source: 'tool', sessionId: 'session-1', evidence: '传目录时偶尔失败', maxImplicitCreates: 1 })
    assert.equal(toolResult.created.length, 1)
    const pending = await store.pendingToolCreationNotices('companion-1', 'weixin:user', 'session-1')
    assert.deepEqual(pending.concerns.map(item => item.subject), ['文件传输偶发丢失目录'])
    await store.markCreationAuditsNotified('companion-1', pending.auditIds, 103)
    assert.equal((await store.pendingToolCreationNotices('companion-1', 'weixin:user', 'session-1')).concerns.length, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('keeps the implicit concern tool scoped and evidence-backed', () => {
  const suggestion = validateConcernSuggestion({
    subject: 'FTP 目录仍无法进入', reason: '用户再次报告目录导航失败', evidence: 'ftp 还是不能 点击进入目录',
    watchKind: 'workspace', watchQuery: 'FTP 目录导航修复', priority: .8, confidence: .9,
  }, '我发现 ftp 还是不能 点击进入目录，麻烦再看看')
  assert.equal(suggestion.watchKind, 'workspace')
  assert.throws(() => validateConcernSuggestion({ ...suggestion, evidence: '用户没有说过的内容' }, 'ftp 还是不能 点击进入目录'), /exact excerpt/)
  const hidden = { tools: [{ name: 'read' }, { name: 'partner_concern_suggest' }] }
  applyConcernToolVisibility(hidden, false)
  assert.deepEqual(hidden.tools.map(item => item.name), ['read'])
  const visible = { tools: [{ name: 'partner_concern_suggest' }] }
  applyConcernToolVisibility(visible, true)
  assert.deepEqual(visible.tools.map(item => item.name), ['partner_concern_suggest'])
})

test('honors explicit notification rules only for knowledge-linked concerns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-rules-'))
  try {
    const store = new PartnerConcernStore(directory)
    const now = Date.now()
    const linked = await store.createExplicit('companion-1', '*', '@知识库[项目长期记忆/nomifun/版本提醒规则]')
    const baselineCandidate = {
      concernId: linked.id, changed: true, event: '发现 v0.7.4 新版本', evidence: '版本高于知识库基线 v0.7.3', source: 'GitHub Releases',
      relevance: 1, confidence: .96, actionability: .9, nextCheckInMinutes: 720,
    }
    const initialResult = await store.recordObservations([linked], [baselineCandidate], now)
    assert.equal(initialResult.observations[0]?.decision, 'feed')
    const linkedResult = await store.recordObservations([linked], [{
      ...baselineCandidate,
      notificationRuleEffect: 'notify', notificationRuleReason: '知识文档规定版本号高于基线时立即提醒',
    }], now + 1)
    assert.equal(linkedResult.notifications.length, 1)
    assert.equal(linkedResult.observations[0]?.notificationRuleEffect, 'notify')
    assert.match(linkedResult.observations[0]?.decisionReason ?? '', /知识文档/)
    await store.markMentioned('companion-1', linkedResult.notifications.map(item => item.id), now + 2)
    const deliveredResult = await store.recordObservations([linked], [{
      ...baselineCandidate,
      notificationRuleEffect: 'suppress', notificationRuleReason: '后续核验暂未达到新的提醒条件',
    }], now + 3)
    assert.equal(deliveredResult.notifications.length, 0)
    assert.equal((await store.activity('companion-1')).observations.find(item => item.id === linkedResult.observations[0]?.id)?.decision, 'notify')
    assert.equal((await store.list('companion-1')).find(item => item.id === linked.id)?.state, 'active')

    const unlinked = await store.createExplicit('companion-1', '*', '普通低优先级变化')
    const unlinkedResult = await store.recordObservations([{ ...unlinked, priority: .4, confidence: .8 }], [{
      concernId: unlinked.id, changed: true, event: '发现普通变化', evidence: '普通来源', source: 'workspace',
      relevance: .8, confidence: .8, actionability: .5,
      notificationRuleEffect: 'notify', notificationRuleReason: '模型自行建议提醒',
    }], now + 1)
    assert.equal(unlinkedResult.notifications.length, 0)
    assert.equal(unlinkedResult.observations[0]?.notificationRuleEffect, 'auto')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reschedules unchanged concerns using the interval selected by the model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-schedule-'))
  try {
    const store = new PartnerConcernStore(directory)
    const now = Date.now()
    const target = await store.createExplicit('companion-1', '*', '关注低频版本发布')
    await store.recordObservations([target], [{
      concernId: target.id, changed: false, event: '', evidence: '尚无发布', source: 'release feed',
      relevance: .8, confidence: .9, actionability: .2, nextCheckInMinutes: 4_320,
    }], now)
    const scheduled = (await store.list('companion-1')).find(item => item.id === target.id)
    assert.equal(scheduled?.lastCheckedAt, now)
    assert.equal(scheduled?.nextCheckAt, now + 4_320 * 60_000)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('keeps explicit concerns stable, ages implicit concerns and supports lifecycle actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-life-'))
  try {
    const store = new PartnerConcernStore(directory)
    const now = Date.now()
    const explicit = await store.createExplicit('companion-1', '*', '关注 OpenAI 新模型')
    assert.equal((await store.due('companion-1', 'any-scope', { now, limit: 12, includeFuture: true }))[0]?.id, explicit.id)
    await store.act('companion-1', explicit.id, 'prioritize', now)
    assert.equal((await store.list('companion-1')).find(item => item.id === explicit.id)?.priority, 1)
    await store.act('companion-1', explicit.id, 'resolve', now + 1)
    assert.equal((await store.list('companion-1')).find(item => item.id === explicit.id)?.state, 'resolved')
    await store.act('companion-1', explicit.id, 'watch', now + 2)
    assert.equal((await store.list('companion-1')).find(item => item.id === explicit.id)?.state, 'watching')
    await store.applyCandidates('companion-1', 'weixin:user', [{ subject: '很久以前的临时问题', reason: '问题长期没有变化', operation: 'upsert', priority: .6, confidence: .76, watchKind: 'auto', watchQuery: '旧问题' }], 'implicit', now - 100 * 86_400_000)
    await store.due('companion-1', 'weixin:user', { now })
    const archived = (await store.list('companion-1', undefined, true)).find(item => item.subject === '很久以前的临时问题')
    assert.equal(archived?.state, 'archived')
    assert.equal((await store.list('companion-1')).some(item => item.subject === '很久以前的临时问题'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('applies explicit named concern lifecycle commands without relying on model wording', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-directive-'))
  try {
    const store = new PartnerConcernStore(directory)
    const now = Date.now()
    await store.applyCandidates('companion-1', 'weixin:user', [{
      subject: '罗小黑工作台样图', reason: '视觉方向尚未闭环', operation: 'upsert', priority: .72,
      confidence: .95, watchKind: 'workspace', watchQuery: '罗小黑工作台样图变化',
    }], 'implicit', now)

    assert.deepEqual(concernLifecycleRequest('不关注 罗小黑工作样图'), { action: 'ignore', target: '罗小黑工作样图' })
    assert.deepEqual(concernLifecycleRequest('我以后不用再巡检罗小黑工作样图了'), { action: 'ignore', target: '罗小黑工作样图' })
    assert.equal(concernSubjectSimilarity('罗小黑工作样图', '罗小黑工作台样图') >= .74, true)
    const before = await store.list('companion-1', 'weixin:user')
    assert.equal(selectConcernLifecycleTarget({ action: 'ignore', target: '罗小黑工作样图' }, before)?.subject, '罗小黑工作台样图')

    const applied = await store.applyUserDirective('companion-1', 'weixin:user', '不关注 罗小黑工作样图', now + 1)
    assert.equal(applied?.concernId, before[0]?.id)
    assert.equal(applied?.action, 'ignore')
    assert.equal((await store.list('companion-1', 'weixin:user')).length, 0)
    assert.equal((await store.list('companion-1', 'weixin:user', true))[0]?.state, 'archived')

    assert.equal(concernLifecycleRequest('为什么不关注罗小黑工作样图？'), undefined)
    assert.deepEqual(protectConcernDirective([
      { subject: '罗小黑工作样图', reason: '模型误判', operation: 'upsert', priority: .8, confidence: .8, watchKind: 'workspace', watchQuery: '样图' },
      { subject: 'SSH 终端遮挡', reason: '另一个问题', operation: 'upsert', priority: .7, confidence: .8, watchKind: 'workspace', watchQuery: 'SSH' },
    ], { concernId: applied?.concernId ?? '', action: 'ignore', target: '罗小黑工作样图', subject: '罗小黑工作台样图' }).map(item => item.subject), ['SSH 终端遮挡'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('migrates old focuses into the concern store exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-partner-concern-migration-'))
  try {
    const store = new PartnerConcernStore(directory)
    await store.migrateLegacy('companion-1', [
      { scopeId: '*', subject: 'DSH 更新', reason: '用户明确要求', confidence: 1, origin: 'explicit' },
      { scopeId: 'weixin:user', subject: '未完成主题', reason: '旧提炼结果', confidence: .8, origin: 'implicit' },
    ])
    await store.migrateLegacy('companion-1', [{ scopeId: '*', subject: '不应再次写入', reason: '', confidence: 1, origin: 'explicit' }])
    const items = await store.list('companion-1')
    assert.deepEqual(items.map(item => item.subject).sort(), ['DSH 更新', '未完成主题'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
