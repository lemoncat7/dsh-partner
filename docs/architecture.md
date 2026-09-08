# Partner architecture

The partner plugin is split by domain rather than by screen. Dependencies point
in one direction:

```text
client -> HTTP feature routers -> application services -> repositories/store
                                      |
                                      v
                              ephemeral execution -> DSH agent/tool APIs
```

## Module boundaries

`tasks/progress-notifier.ts` orders persisted final-result delivery before internal
agent follow-ups, with separate error boundaries. Knowledge 2.6.0 owns durable
writeback snapshots, plans, retries and status; Partner does not copy its queue or
patch the DSH loop. Channel results do not wait for extraction. Retrying writeback
does not rerun the partner's turn or resend its channel message. This does not
make channel delivery and knowledge writes one atomic transaction.

Configuration saves only commit state. The awaited `agent/pre-step` hook compares
the saved configuration with the installed revision before each new turn, covering
native history resume as well as local, channel and task-board conversations.
Unchanged configurations do not re-register tools or read Skill bodies again;
mid-turn saves never dismantle a running composition. No polling or eager wakeup
of inactive sessions is needed. Plugin-owned tools recheck capability revocations
at execution even when an old schema remains in the current turn.
The UI reports saved/next-turn, separately from request failures and refresh
failures. Preset and model defaults remain subject to DSH session-selection rules;
the plugin does not bypass restrictions on changing an existing session's preset.
`companions/session-configuration.ts` indexes persisted routes and configuration
revisions without transcript copies. `ui/capability-editor.tsx` owns the capability
form and save feedback, using the shared companion draft and existing UI tokens.

- `core/`: shared validation, identifiers and bounded collections. It contains
  no partner feature policy.
- `execution/`: the only owner of short-lived DSH agent sessions. Skill forks,
  delegations and schedules use this service instead of recreating agent setup.
- `companions/`: the only owner of companion identity creation and its initial
  local-session transaction. API and model tools share this boundary; failed
  session provisioning rolls the new identity back.
  `management.ts` owns high-privilege configuration validation, live authority,
  revision checks and one serialized identity/Skill/access mutation;
  `management-tool.ts` is the scoped model adapter. `knowledge-mounts.ts` is an
  optional host-service adapter, not a second knowledge store or HTTP client.
- `capabilities.ts`: the shared capability identifiers and labels for domain
  normalization, the client and the management catalog; no duplicate enums.
- `skills/`: Skill metadata, filesystem loader, atomic installer, market cache,
  bounded proxy-aware network transport, companion bindings and model-facing
  tools. Skill bodies stay on disk; the JSON state only stores indexes,
  checksums and non-secret local network preferences.
- `tasks/`: task-board state, optimistic revisions, activities and model-facing
  tools. UI drag-and-drop is never the only way to move a task.
- `collaboration/`: directed companion grants, the public capability directory
  and delegation envelopes. It never exposes another companion's private
  transcript, credentials or memory store.
- `scheduler/`: schedule calculation, overlap policy, restart recovery and run
  history. It does not implement agent execution.
- `api/features/`: thin HTTP adapters. Parsing and response mapping live here;
  business policy stays in services.
- `client-controller.tsx`: owns opening/closing the plugin workspace and
  preparing, renewing and switching DSH sessions. It has no page markup.
- `client.tsx`: the composition root for sidebar registration and companion
  detail routing. It does not own reusable controls or session orchestration.
- `ui/workspace-components.tsx`: the shared workspace template contract. Page
  heroes, content sections, focus-managed create/configure drawers, notices,
  empty states and loading skeletons are defined once here.
- `ui/partner-components.tsx`: small companion-specific presentation
  primitives such as identity marks, channel status, form fields and section
  headings. These components do not fetch data.
- `ui/*-panel.tsx`: one feature per module. Skill installation, the shared
  board and schedules are top-level destinations; each panel owns only its
  resource state and business actions and composes the shared templates.
- `ui/workspace-ui.css`: interaction and material rules for the shared
  templates. Feature-specific layout may remain in `client.css`, but new
  cross-feature UI contracts belong in this module.

## Persistence rules

- `partner-state.json` remains the atomic metadata store.
- Skill contents live below `<defaultCwd>/partner-system/skills`.
- Task activity, delegation and execution histories are bounded before commit.
- Every state mutation is serialized by `PartnerStore`; task edits additionally
  use a revision to reject stale concurrent updates.
- Requirements retain `revision` for full snapshot/summary/delivery invalidation.
  `controlRevision` records the last scope or lifecycle edit in that same sequence.
  Ordinary requirement commands accept observed revisions between that boundary
  and the current revision; child creation, progress and comments do not force a
  new read. Child specification edits, removals, owner/scope edits and lifecycle
  commands move the boundary. `finish` and task review remain exact-version checks.
  Legacy records start conservatively at their current revision on their first
  change. Conflicts return current requirement content and explicit reconciliation
  guidance, never silently retry stale edits or regenerate a requirement.
- Market downloads are bounded, checksum-verified when supplied, written into a
  temporary directory and atomically renamed.
- Market discovery and package installation share one bounded transport. The
  optional local HTTP proxy applies to both paths and rejects embedded proxy
  credentials.
- Public ZIP packages are parsed in memory and archive paths are never
  extracted to disk. A case-insensitive `SKILL.md` is preferred; a package
  with exactly one Markdown document may use that document, while ambiguous
  multi-Markdown packages are rejected.

## Client interaction rules

- Creation and configuration flows use the shared focus-managed drawer. They
  restore focus on close, trap keyboard focus while open, close on Escape and
  never rely on browser-native dialogs.
- Lists expose loading, empty, error, disabled and retry states without moving
  errors to an unrelated page footer.
- Visual feedback uses opacity and transforms. Static overview cards do not
  create pointer tracking, SVG displacement filters or per-card resize
  observers.
- Form controls and buttons are fully styled by the plugin; browser and theme
  defaults are not part of the component contract.

## Capability and privacy rules

- A Skill may only narrow inherited tool access. It never grants a tool that the
  companion did not already have.
- New companions start with no declared capabilities, memory, daily review,
  heartbeat, channels or collaboration grants. The `partner_companions` tool is
  only composed for a companion explicitly granted the `companions` capability,
  and it may create identity fields only. Later permissions require the user or
  a separately authorized administration companion.
- `administration` defaults off and can only be granted/revoked by the user UI.
  The companion-scoped `partner_companion_manage` tool may inspect/change other
  companions, never itself; directed collaboration access is not administration.
  Private memory, conversations, channels and credentials are outside its schema.
  Identity, enabled Skill IDs and outgoing grants commit together. Unknown
  fields, stale revisions, cancellation, missing resources and busy targets
  fail closed. Authority is checked again inside the serialized store write.
  A runtime confirmation error after commit is reported as saved/next-turn with
  a warning, not a failed write. Browser-owned Agent handles are not destroyed.
  Unspecified settings, including automation, remain unchanged.
- Knowledge mount management is a separate provider-backed operation. The
  adapter derives the target's default project and existing session scopes on
  the server, never from model-supplied paths. It calls the optional
  `dshKnowledgeMountManagement` v1 service, retains provider token permissions,
  and rechecks actor authorization, target activity and scope ownership just
  before the provider starts writing. A request already accepted by a remote
  server cannot be retroactively canceled by revoking local capability.
  Disabled rows prevent accidental inherited reactivation. No package-level
  dependency, fallback store, new global tool or extra background polling is used.
- Market Skills execute in a forked temporary session by default.
- Companion collaboration exposes identity, declared capabilities, enabled
  Skill names, availability and the assigned task envelope only.
- Cross-companion directory access, assignment and `@companion` delegation use
  explicit directed grants (`A -> B`). A grant is not reciprocal. The model
  receives only A's granted directory and the service checks the same edge
  again at execution time. User-initiated board delegation is a separate actor
  and may target any created companion without impersonating another partner.
- A companion may submit its own assigned stage without a cross-companion
  grant. Other-companion execution always requires the directed grant above;
  assigned-stage instructions forbid recreating the same work recursively.
- Scheduled jobs default to non-overlapping execution and a disposable session.

## Companion deletion safety

- `companions/removal.ts` serializes removals, binds each operation to one ID,
  blocks active work/last-companion deletion, and keeps the identity retryable
  if directory cleanup fails. An in-memory removal guard prevents new partner
  sessions, task claims, heartbeat and daily-review work during deletion.
- `companions/directory-cleanup.ts` derives only `<defaultCwd>/partners/<id>`;
  it rejects traversal, shared/nested workspace paths, symlinked roots and
  mounted volumes. Nested symlinks are removed without following their targets.
  Filesystem cleanup finishes before deleting identity. This is not a cross-store
  transaction: a failed filesystem deletion can have removed some files, and a
  later state-write failure leaves the identity available for retry.
- The identity editor sends `DELETE ...?removeFiles=1` only after a named
  confirmation describing permanent deletion. Older callers without this flag
  retain file-preserving behavior. Neither path scans historical orphan folders
  nor purges DSH's global session persistence; the current host has no supported
  permanent session-log deletion API. `workspace-cleanup.ts` removes only the
  dedicated workspace registration through the public host API.
- `ui/identity-editor.tsx` isolates confirmation and async feedback per companion,
  prevents duplicate clicks and returns the selected deletion to the overview.
  `test/companion-removal.test.mjs` and `scripts/verify-companion-removal.mjs`
  use disposable fixtures; physical deletion never runs against live user data
  as part of these regression tests.

## Proactive planning and durable task dispatch

- `collaboration/task-recovery.ts` distinguishes an early review status from a
  committed deliverable. Previously started task delegations may resume an empty
  review after interruption, subject to assignment, access, dependency and
  concurrency checks. Saved results/reviews are never rerun through this path.
  Startup repairs only known coordinator cancellations, with shutdown evidence
  for the status-mismatch bug and no superseding task delegation. Arbitrary user
  cancellations are not revived. Result notification is wired before recovery
  starts claiming work.
- `channels/delivery-policy.ts` keeps internal task/review continuations out of
  channel replies, including nested goal completion notices. User-origin turns
  retain creation acknowledgments and explicit progress answers. Accepted task
  results use the separate deterministic delivery path and persistent receipts;
  intermediate execution/review notices are not additional channel messages.
- `skills/task-planning.ts` owns the built-in planning instructions (1.2.0).
  Matching multi-deliverable requests proactively use enabled Skills and the
  authorized directory's stable IDs, roles, descriptions and Skill names.
  Inline Skills are already injected and do not require a redundant load call.
  Simple answers and explicit discussion/planning-only requests do not launch
  work. This is a model instruction contract, not a guarantee of model choices.
- `collaboration/composition.ts` maps assigned tool-created tasks to explicit
  `autoRun` intent by default; `autoRun=false` or explicit backlog preserves
  planning-only behavior. The board creation form exposes the same choice.
  The storage service itself defaults to planning-only, so legacy records and
  other callers do not silently acquire execution permission after an upgrade.
- `tasks/service.ts` persists intent and validates task state/dependencies.
  `collaboration/task-dispatch.ts` owns pure eligibility, authorization and
  bounded-queue helpers. `collaboration/service.ts` uses its existing recovery
  timer to enroll intent and claim work atomically, with at most three running
  delegations. No additional polling loop or external queue is introduced.
- Assignment plus explicit delegation commits atomically. Repeat submissions
  of the same task to the same pending executor return that job, not another
  execution. Missing or unaccepted dependencies prevent execution; all
  prerequisites must be `done` after acceptance before downstream work starts.
  Accepted prerequisite summaries enter the executor prompt with bounded size.
- The scheduler rechecks directed grants, executor identity and current task
  state before claiming and again checks authorization before execution.
  Queued/running jobs are never evicted to retain terminal history. Switching
  to planning-only cancels waiting task jobs, not already-running work or review.
  Restart recovery retains submission intent; old tasks without `autoRun=true`
  are not enrolled automatically. Submission returns without awaiting results.
- `ui/task-board-stage.tsx` owns stage collapse and progressive disclosure:
  six cards initially per stage (twelve when focused), then twelve per expansion.
  Responsive horizontal card grids share the page scroll instead of fixed-height
  nested scrollboxes. Mobile uses compact stage/assignee filters. Existing
  semantic colors and dialogs are retained without new card animations.
- Regression coverage: `test/task-dispatch.test.mjs` exercises real storage,
  composition tools, dependency chains, restart intent, idempotency, concurrency
  and permission changes. `scripts/verify-task-board.mjs` tests the actual panel
  with isolated fixtures across phone, landscape and desktop in both themes.

## 需求看板与整体收尾

- `requirements/domain.ts` 与 `service.ts` 定义需求归属及规划、提交、汇总、归档生命周期。伙伴工具创建必须显式传入 requirementId，缺失时不产生任何记录；`tasks/requirement-link.ts` 给出依赖所属需求的核对线索，但不猜测归属。仅旧内部调用/人工接口保留单任务需求兼容逻辑。规划提交后不能直接增加任务，续做先重开规划。
- 同一目标续做可以明确 reopen 已归档需求，`requirements/archive.ts` 保留旧总结、交付快照和投递时间（最多 20 次，达到上限明确拒绝，不静默丢弃）。reopen 的 title/description 用于扩展新阶段范围，不失效已验收任务；update 才用于改写旧验收要求。仅重开不触发旧成果再通知，新增任务后按批次继续汇报。
- `requirements/consolidation.ts` 是显式维护用的纯状态操作，不注册伙伴工具、不按标题在启动时迁移。只允许同负责人、同来源、子任务全部完成且来源归档已通知的两个需求合并；保留原任务 ID、依赖、成果与归档历史，不重新执行或重复投递，版本变化立即拒绝。
- `requirements/worker.ts` 单并发汇总已提交且全部子任务验收通过的需求。总结及交付快照先持久化，再向原始创建渠道投递；失败指数退避，重启继续，已保存的总结不会因通知失败重新生成。投递复用持久化 receipt，已确认发送不重复发送；网络发送与本地 receipt 写入不是跨系统事务，不承诺绝对 exactly-once。
- `requirements/progress.ts` 独立判定阶段通知：非空需求只剩 done/blocked 且没有 queued/running 委派才可汇报；backlog/ready/doing/review 任一存在都静默。稳定 15 秒且负责人空闲后汇总一次；阶段内容与指纹先持久化，失败重试复用内容，追加任务会中止过时汇总。阶段通知不需要归档，明确确认整个需求完成后可以 finish 规划态需求；未完成或受阻任务禁止被伪装为完成归档。
- `tasks/context.ts` 为执行、核验和创建者回调提供同一份最新需求、任务补充、打回理由及上次交付。修改实际需求会原子失效旧执行，工作版本阻止迟到结果覆盖；核验 accept/reject 使用实际读取的任务版本，防止旧意见打回新版。普通讨论保留当前执行，但会使旧验收决定失效。已验收事件不再携带历史返工指令。
- 子任务完成、验收、受阻只反馈给内部创建伙伴；渠道不逐任务播报。人工从看板创建的需求不会自动投递到负责人的其他聊天。汇总输出沿用长结果文档及真实附件投递能力。
- `tasks/removal.ts` 原子移除任务、活动、委派，取消关联执行；未完成的依赖者暂停，并重新打开需求范围确认。重复删除成功，执行器迟到结果不能重建记录。归档保留不可变交付快照，删除子任务不会抹去最终结论。
- `ui/requirement-board.tsx` 负责需求总览与归档入口；`requirement-dialog.tsx` 负责需求表单和详情；`requirement-tasks-panel.tsx` 负责需求内的任务阶段和任务详情，`task-board-panel.tsx` 仅保留稳定入口。统一复用工作区表单、字体、色彩与弹窗，次要信息通过折叠区展示，无新增模糊层或卡片动画。
- `ui/board-refresh.ts` 合并刷新并用版本号丢弃旧响应，页面隐藏暂停轮询；进入需求后停止后台总览轮询。需求列表分批展示，任务阶段只展示非空阶段，避免堆叠空列。
- `test/requirements.test.mjs` 覆盖范围确认、归档、权限、并发删除、执行取消、持久化重试；`test/channel-media.test.mjs` 验证子任务静默与需求最终通知。

## 整份计划、验收契约与资源调度

- 分工策略仍属于内置 `task-planning` Skill（1.5.0），工具只提供执行协议，不新增前置 Skill、行业硬编码流程或工具拦截器。升级不覆盖用户自行维护的同名 Skill。
- `requirements/plan.ts` 在一次串行 `PartnerStore.update` 中校验并保存需求、1–40 项任务、活动与幂等回执；网络/Agent 执行只发生在提交之后。`requirements/draft.ts` 与 `tasks/draft.ts` 共享纯创建逻辑，避免服务循环引用。
- `submit_plan` 使用局部 `key/dependsOn` 解析前向引用；校验全图循环、同需求已有依赖、执行者/验收者授权、执行者 Skill 绑定及容量，任一失败不留下半份计划。追加仍要求原需求处于 planning 且控制版本有效，不隐式 reopen 或覆盖原需求。
- `submissionKey` 按提交伙伴隔离，规范化载荷摘要识别重复；重试返回既有 ID 与当前状态，`execution=unchanged` 不代表再次启动。回执持久化，删除任务/需求不会删除回执或借重试复活工作。最多 2000 份回执，达到上限拒绝新计划、保留旧键而非自动淘汰；历史维护必须显式处理，普通重试仍可使用。
- `autoRun` 表示执行意图（默认 true），`completeScope` 表示整个需求范围已规划完整（默认 false），两者独立。沿用原调度器、恢复机制与需求级通知，不新增第二套运行队列，也不改变验收中间步骤不通知渠道的规则。
- `tasks/contract.ts` 集中校验有序验收清单、执行证据和逐项核验结果。accept 必须全部 passed 且有核验证据；reject 必须包含具体失败/未验证原因。这里只验证报告结构，不运行检查、不证明模型声明为真。旧任务不带清单仍兼容旧协议。
- 证据通过 `<partner-evidence>` JSON 解析并与公开交付分离；格式错误保留交付、记录内部核验警告，不因元数据错误重跑外部动作。打回保留逐项缺口，范围变化使旧工作版本与旧证据失效。
- `tasks/scheduling.ts` 共用调度判定和只读等待说明。相同 `resourceKeys` 在看板内互斥；claim 时保存声明快照，取消/删除后保留进程内占用直到执行器退出。没有冲突的任务维持最多 3 路并发，不把同一伙伴一律串行化；跳过资源等待项继续寻找可运行任务，避免队首阻塞。
- 资源声明不是操作系统锁，也不约束其他会话或插件；Skill 必须给重叠写操作填写一致标识。重启恢复依赖原持久化队列；外部命令是否中止、产出是否已存在仍由恢复执行者核对，不能承诺外部副作用 exactly-once。
- `ui/task-contract-panel.tsx` 独立展示证据与人工核验表单，复用现有主题控件；卡片只显示简短等待原因，详情显示前置/冲突任务与重试时间。无新增依赖、轮询器、背景材质或动画。
- 专项回归：`test/board-plan-contracts.test.mjs`；隔离浏览器验证：`scripts/verify-task-board.mjs`（手机/平板横屏/桌面、明暗主题、长证据换行、验收按钮状态、错误后保留表单）。

## 明确附件交付

- 每个伙伴作用域注册 `partner_send_attachment`，由伙伴明确指定 `path`，而非自动扫描生成工具或 Markdown 引用。会话普通回复不再通过链接隐式发送附件；需求汇总的既有文档投递流程保持独立。
- `attachments/service.ts` 校验当前会话目录内的真实文件（包括 realpath/符号链接边界、支持格式、64 MB 上限），保存只读语义的内容快照和 SQLite 交付回执。文件变化时拒绝提交；来源文件移动或删除后仍可按 `deliveryId` 重试。存储位于状态文件同级 `attachment-deliveries/`，权限 0700/0600，累计记录容量上限 512 MB，满后拒绝新交付，不自动删掉仍被会话引用的文件。
- `attachments/tool.ts` 通过 DSH `deferContext` 返回带来源的附件消息，图片使用原生 `attachments.saveImage` 持久化引用，文档使用已认证伙伴 API 下的下载链接。嵌套 `run_code` 沿用 DSH 的 deferred context 协议，不依赖模型复述 Markdown。`api/features/attachments-api.ts` 只接受交付 ID，核验完整性后强制 attachment 下载、nosniff/private/no-store，不接受任意文件路径、不提供匿名分享。
- 直接会话仅向自身绑定且已批准的渠道交付；内部看板执行、验收与汇总不逐项外发。服务复用已有微信上传协议，回执区分 sent/failed/none；相同会话同一用户输入下相同文件内容幂等，已确认成功的交付重试不重复发。网络成功但确认丢失或进程恰在外部发送与本地落盘间退出时仍可能重复，不能承诺跨微信 exactly-once。不自动重生成或无限重试。
- 不自动下载任意 URL、不读取其他伙伴的私有目录、不扫描中间产物。远端文件需由已有授权工具先下载到当前会话目录；无效路径明确报错。伙伴删除后下载入口拒绝其交付，文件保留规则与管理清理应另行明确。
- 回归：`test/attachment-delivery.test.mjs` 覆盖快照、重启回执、发送失败重试、成功去重、原生图片内容、内部渠道静默、跨伙伴拒绝、路径/符号链接边界、下载响应；`test/channel-media.test.mjs` 确认普通 Markdown 不再隐式交付。

## 主界面挂饰与消息

- `pendant/frame-loop.ts` 独立负责可选 24/30/60 FPS 绘制调度（默认 30，旧配置自动兼容）：定时器临近截止时间再进入 RAF，保留非整除刷新率的小数节奏，高频输入合并唤醒；运行时切换只重排唯一待执行回调，不重建 WebGL/物理场景，休眠中切换不启动循环。隐藏/卸载取消计时器和 RAF。物理仍以 120 Hz 固定小步推进，停顿后不追赶后台时间。握持状态不再强制常驻循环，绳子平稳后可休眠，保持弹簧位置和储能，移动/松手重新唤醒。

- 绳子材质由 `strap-style.ts`（色阶与宽度）、`strap-geometry.ts`（沿曲线的织纹/交错绳股/双侧缝线）和 `strap.ts`（固定 SVG 节点池）分层负责。设置预览和材质小样用 `strap-preview.tsx` 复用同一几何；纹理沿弧长和切线排布，最多 256 个采样、8 层路径，不使用模糊滤镜、逐根绳股 DOM 或额外 GPU 贴图。颜色、线宽等属性只在外观或尺寸变化时更新，静止时沿用渲染器休眠。

- “卡片设置”位于定时任务之后，是独立工作区页面。`pendant/settings.ts` 负责设置校验，`use-settings.ts` 通过外部存储订阅统一管理当前浏览器的开关、材质、颜色和正面图片；跨标签同步，存储失败不覆盖已生效配置，未保存草稿不被其他标签覆盖。关闭会卸载挂饰、轮询和 GPU/物理资源，不影响服务端消息保留。
- `pendant/settings-panel.tsx` 复用工作区表单、提示与按钮；预览使用静态 SVG，不额外创建 WebGL。`strap-style.ts` 为预览与实际绳子提供同一套视觉参数，不改变物理参数。`card-image.ts` 本地验证和解码 PNG/JPEG/WebP（5 MB、2500 万像素上限），保留完整比例、最长边不超过 1024 的 JPEG（最多 700000 字符）到 localStorage；不接收外链/SVG，不上传图片。`imageFit` 默认 `contain` 完整显示，可切换 `cover` 居中铺满；CSS 预览与 Canvas 均等比缩放，空余部分统一使用卡面底色，切换不重编码或裁掉源图。旧版已裁切的图片无法恢复缺失像素，需重新上传。绘制仍复用 512×704 纹理和原画布，异步解码使用修订号避免旧图片覆盖新设置或卸载后更新。

- `pendant/widget.tsx` 通过 DSH `shell.overlay` 加法插槽提供单一挂饰，独立于会话和伙伴面板；不修改宿主布局或 DSH 源码。
- `pendant/renderer.ts` 是单独构建的同源 ESM 资源。使用 Three.js + Rapier 实现 React Bits Lanyard 风格交互，不是原组件的逐字移植；卡牌与纹理由插件生成，无外部模型/图片请求。渲染库打进独立资源，不成为用户安装时额外解析的运行时依赖。
- `pendant/surface.ts` 与 `image-coating.ts` 分开合成源图与光效，源图不参与照明/曝光映射，背面物理反射保持不变。正面的 `motion-glare.ts` 保留 React Bits GlareHover 斜向渐变形状，但取消时间进度、速度触发、淡出和循环：将固定世界光源/视线半角向量投影到卡片局部坐标，用实际四元数确定光带位置与强度（上限 38%）。同一角度输出完全一致，反向旋转沿原路返回，停住时保持反光；正反面过渡按朝向平滑衰减，减少动态效果时关闭。不改源图、法线、几何和背面通知，也不增加绘制、画布、计时器或 RAF；可见高光不阻止静止休眠。来源许可见 THIRD_PARTY_LICENSES.md。
- 六像素拖动阈值隔离点击与拖动；取消、失焦和卸载释放指针捕获。静止后停止 RAF，后台暂停，卸载时销毁 GPU 与物理资源。WebGL 不可用时保留普通消息入口。
- `pendant/physics.ts` 独立负责物理连接：三个弹性关节储存拉伸能量，球形关节允许卡牌翻面，固定 120Hz 物理步进与绘制帧率解耦。握持时停顿也能回弹，不靠松手时注入假的回弹冲量。拖动转向与实际时间采样的释放速度提供翻转惯性。
- 拖动不施加人为坐标/长度限制。卡牌使用固定比例的正交视图，在独立的小 WebGL 画布中绘制，用 CSS transform 移动；拖动距离和物理深度不再改变绘制尺寸或放大卡牌。`pendant/strap.ts` 独立绘制矢量绳带，不分配全屏 GPU 缓冲。布局只在容器/窗口尺寸变化时读取，指针事件使用缓存的线性坐标映射。静止后休眠，不以固定时长截断回摆。
- 点击层不绘制材质或装饰边框，鼠标拖动不触发键盘聚焦，键盘操作保留可见焦点。卸载时一并清理小画布、绳带节点和物理资源。
- `pendant/use-placement.ts` 只负责挂点位置：拖动顶部挂点或用方向键移动整件挂饰，与卡牌拉伸手势分离。位置按可用视口比例保存在本地浏览器，刷新恢复，窄屏及旋转时约束到可见范围；逐帧移动不触发 React 状态更新，完成时才写存储，不查询宿主私有 DOM。
- 卡牌正面只负责图案，消息更新不会重绘或覆盖正面纹理；内侧单独绘制未读数量、伙伴名和简短状态。图案与消息使用独立纹理，不自动弹出消息或额外角标。
- `pendant/notice-motion.ts` 统一处理新消息提醒：等待被握持或快速甩动的卡牌空闲，轻摆并以短暂的物理角速度辅助转向文字面（背面，Y 轴半周），再由 `pendant/sheen.ts` 仅在文字面轻扫光两次。结束或阅读后不自动恢复图案面，也不持续锁定朝向；抓取可中断，用户仍能自由翻面。多条到达合并一次动作；后台、全部已读及减少动态效果时取消。效果共用卡面圆角几何，不使用全屏后处理、独立计时器或逐帧纹理重绘。挂点旁保留静态小数字未读标记（超过 99 显示 99+，全部已读后隐藏），翻面及减少动态效果时仍可见，不拦截拖动、不唤醒渲染循环；读屏复用消息按钮和现有单一播报区。
- `pendant/reader.tsx` 点击打开最新未读正文（无未读时展示列表），保留可见、可玩的挂饰；桌面优先放在卡牌旁边，窄屏选择卡牌上方或下方的可用空间。正文独立滚动，来源操作留在底部；使用独立冷灰纸面材质，支持 Escape 关闭、键盘焦点返回、卡牌再次点击关闭和来源导航。静止挂卡即使在阅读时也会自然休眠。
- `notifications/service.ts` 从已提交的任务/定时执行变化和完整伙伴回复生成终态通知；不改变任务执行，不暴露内部验收交接。普通回复按会话和轮次去重，任务按 ID/修订/终态去重。
- `notifications/store.ts` 在主状态文件同目录保存 `partner-inbox.sqlite`，权限 0600，最多 200 条摘要（每条最多 2000 字符）及已读状态。它不是新的会话历史；完整内容仍在原任务/会话中。
- `api/features/pendant-api.ts` 沿用原有 API 同源和写操作校验，只提供固定渲染资源、消息查询和批量已读。前端可见时每 4 秒条件查询（ETag）；无变化不传正文，失败退避至 30 秒，隐藏或卸载时取消请求。
- 验证：`test/pendant-inbox.test.mjs`、`test/pendant-physics.test.mjs`；构建后设置 `PARTNER_PLAYWRIGHT_MODULE` 并运行 `node scripts/verify-pendant.mjs`，使用隔离假数据检查 WebGL、真实拖拽、拉住停顿后的回弹与反向振荡、休眠、键盘、通知导航、移动端和清理。可设置 `PARTNER_PENDANT_VIDEO_DIR` 保存连续交互录像。
- 卡面验证：`test/pendant-motion-glare.test.mjs` 覆盖角度往返、固定姿态十秒不漂移、四元数等价、强度边界、减少动态效果和背面关闭；`test/pendant-surface.test.mjs` 覆盖共享 uniform 与背面不变。`scripts/verify-pendant-gloss.mjs` 检查 162 组原色误差、渐变参考对照、不同倾角的光带位移与对比度保护及无额外绘制。浏览器测试覆盖 hover 不改变反光、拖拽改变角度时更新、握持静止高光不循环并正常休眠。
