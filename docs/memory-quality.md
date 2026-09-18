# Memory quality and layered processing

This branch retains existing memories and history archives, adds SQLite tables
without rewriting existing records, and introduces no external service or vector
model dependency. There are no UI/theme changes. Daily review reuses its existing
model request for optional scene and experience proposals.

## Responsibilities

- `memory-reflection.ts`: candidate extraction and lifecycle instructions. One-shot
  work belongs in the daily summary; continuing observation belongs in concerns.
- `memory-quality.ts`: validates candidate quotes against user speech. Assistant
  responses and generated summaries are not evidence. Ambiguous or missing sources
  are rejected, including completion/removal proposals. Daily review uses real turn
  IDs rather than recording its synthetic summary as evidence.
- `memory-store.ts`: scoped target-ID updates, lock protection and persistence.
  Unknown, cross-scope or wrong-kind targets never fall back to inserting a row.
  Exact subject matching remains available for legacy callers. Model-selected IDs
  enable synonymous subject updates without destructive fuzzy automatic merging.
- Read-time status marks expired active entries as expired without rewriting data.
  Renewed durable preferences/profiles/relationships clear old implicit expiration;
  an explicit new expiration is preserved. Corrections can lower confidence.
- Chinese bigrams and preserved Latin word boundaries improve lexical ranking.
- `memory-journal.ts`: durable turn payloads, extraction checkpoints, expiring
  leases, exponential retry backoff (30 seconds to 1 hour). Scoped FIFO prevents
  old retries from overwriting newer work. Other scopes may continue independently.
- `memory-worker.ts`: lifecycle, opt-out/removal checks and background scheduling.
  Per-turn extraction and daily review share a single model slot. Shutdown aborts
  in-flight model work, and failed jobs remain recoverable. A crashed lease expires
  within five minutes. Model calls retain their 60/90-second deadlines.
- `memory-retrieval.ts`: relevance and ranking without model calls. No unrelated
  memory padding. At most two history fragments from the most recent 100 durable
  turns and two scene views are included in topic context. Assistant history is
  explicitly labeled as unverified historical output, never as a user fact.
- `memory-artifacts.ts`: source-linked scene views and reviewable experience
  drafts. Scene content is derived on read, so corrections/deletions immediately
  propagate. Drafts require positive user evidence from at least two sessions;
  repeated tool use alone is insufficient. No auto-install, auto-binding or edits
  to existing skills. At most 100 scenes and 100 drafts per scope are retained.
- `profile-domain.ts`: deterministic, versioned persona baseline. Includes up to
  four repeatedly evidenced high-confidence preferences (or user-locked entries),
  alongside explicit identity facts. No inferred personality or sensitive traits.
- `api/features/memory-layers-api.ts`: authenticated-parent management routes,
  manual retry, paginated history, optimistic-version draft review/export.

## Transaction and recovery boundaries

Enqueue persists before returning from the session event. The stable turn ID
deduplicates duplicate events. Extraction is checkpointed before writing memory;
memory changes, daily count and the commit marker share a SQLite transaction.
Retries reuse checkpointed output, not another model completion. Concern batches
have a separate idempotency record. New concern notification is attempted before
the job is marked complete. Delivery is at-least-once: a process crash after delivery
but before commit can still duplicate a notification; it does not duplicate memory.

Daily review defers while its scope has pending turns, and checks again in the
write transaction. Normal retention no longer deletes active non-expiring memories
or locked records. Pending jobs are retained regardless of history age. Completed
turn payloads follow history retention; this also defines their deduplication window.
Maintenance runs at most once per six hours per active companion after success.

## Management endpoints

Under the existing companion API prefix, all require the parent route's existing
origin/access checks. Supply the exact contact `scopeId` as a query parameter:

- `GET /companions/:id/memory/layers`: scenes, drafts and pending/retrying jobs.
- `GET /companions/:id/memory/history`: newly journaled history, up to 30 turns.
  Next page uses the last row's `at` as `before` and `id` as `beforeId`, including
  ties. Older JSONL archives remain available to daily review; not bulk-migrated.
- `POST /companions/:id/memory/jobs/:jobId`: retry a non-running pending job now.
- `POST /companions/:id/memory/experiences/:draftId`: body `{action, version}`;
  action is `approved` or `rejected`. Stale versions cannot review newer content.
- `GET /companions/:id/memory/experiences/:draftId`: export approved Markdown in
  a JSON `document` field. Installation uses the existing explicit Skill workflow.

## Memory workspace

The companion's top-level tabs separate **记忆** from **持续关注**. Memory opens
on a contact-scoped profile, with explicit facts and stable collaboration preferences.
The primary navigation is 画像 / 记忆 / 回顾; scenes and chat history are secondary
views, while experience review and relationship auditing live under 更多.
Learning and heartbeat settings use the shared workspace dialog independently.

`src/ui/memory/` owns these components. The resource hook aborts obsolete requests,
keys results to their requested path and pauses polling in hidden documents.
Memory rows render in batches of 20; graph/history requests start only when opened;
long history bodies mount only on expansion. Editors retain their local drafts
during background refresh. Retry and review operations guard duplicate submission.
The legacy memory endpoint also accepts `scopeId` so a busy contact cannot consume
another contact's 100-row result limit. No existing memory data is moved or deleted.

Browser regression: `PARTNER_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs
node scripts/verify-memory-workspace.mjs` (with installed Chromium). This uses
isolated fixtures and checks phone/tablet/desktop in both themes, scope switching,
filters, lazy graph/history, settings feedback and duplicate submission prevention.

## Boundaries

Quote verification establishes provenance, not semantic truth: classification and
whether a quote supports a claim still depend on extraction quality. Existing locked
memories remain authoritative. Repeated or unrelated retrieval candidates are not
automatically merged or deleted.

Missing-evidence proposals are not written; their original conversations remain
available for daily review within history retention. Successful procedures are
proposals, not proven executable programs: users must review applicability and
safety before installing. Scene generation and draft generation depend on daily
review being enabled. No psychological inference, automatic memory cleanup,
cross-contact sharing, vector service or autonomous skill activation is introduced.

Validation: `npm test`, including memory quality, journal recovery, artifact
provenance and profile/recall regression tests. Local deployment still requires
a consistent SQLite backup and health checks; unit tests cannot prove live model
extraction quality or remote-channel availability.
# 统一会话画像修复

- 已连接到同一伙伴本地会话的渠道，共用该会话的记忆范围。普通回复、插话、画像加载和记忆页面使用同一规则；没有连接到该会话的历史联系人仍隔离。
- 启动时事务归并已连接渠道的旧记忆、历史、日记及记忆关系，保留条目 ID 和证据。同日回顾合并，不重复累计。关注的渠道来源独立保留，不随画像归并改变投递目标。
- 逐轮提炼明确要求 `evidenceQuote` 和 `sourceTurnId`；候选格式或原话校验失败进入持久化重试，不再被当作空记忆成功处理。没有值得保留的内容仍允许返回空数组。
- 开启学习的伙伴，首次升级会在后台复查统一范围内最近最多 30 条“成功但记忆为空”的历史轮次，仅补充画像和偏好。修复只运行一批，新对话优先；重启续跑，保留日记计数，不重放关注与通知，也不覆盖更新或手动锁定的事实。
- 单次有证据的高可信长期偏好可以进入画像；较低可信偏好仍需要重复依据。没有身份背景依据时不凭空生成职业或性格。
# 综合画像

画像分为基础记忆和独立的综合理解，不再要求先具备职业、身份等固定字段。
综合理解按背景与目标、持续兴趣、沟通协作、近期变化组织；没有证据的部分不填。
明确表达与多轮观察分别标注，观察至少引用两个不同用户轮次，助手回答不能充当用户画像证据。

综合画像在现有串行记忆工作器中生成，不阻塞渠道回复。沿用记忆模型配置，输入不变不调用模型；
自动更新最短间隔十分钟，手动重新整理可提前触发。学习暂停时停止生成，已有画像仍可查看、纠正。
输入限制为最近24条有效背景/偏好/关系记忆、20条用户交流，以及旧画像仍有效的引用；
正文最多8段、2400字符。已有引用不因最近对话窗口滚动而失效，但删除、过期或修改依据后立即停用。

SQLite 保存任务租约、错误与退避重试状态；模型失败保留有效旧画像，进程重启后过期租约可重新领取。
保存时验证租约和依据，用户纠正会使旧任务失效，防止旧结果覆盖。最近五份旧版本留存在本地数据库中
（当前不提供历史浏览入口）。纠正只针对综合理解；基础记忆可以在下方展开并单独修改。
界面统一为记忆列表，画像、偏好等按类型筛选，点击条目查看依据与可信度或修改。
用户概述默认折叠在列表上方，展开后同主题合并成连续章节；依据与修正按需展开。
临时任务、工具使用记录和项目进度不作为人物特征，跨轮次重复同一个任务也不等于长期兴趣。
界面沿用记忆面板15秒刷新；重新整理、失败和纠正均显示状态反馈，不增加动画和新配色。
画像是辅助上下文，不是指令或授权；始终以用户当前陈述为准。
