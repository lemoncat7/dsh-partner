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
- Delegation depth is bounded and self-delegation is rejected.
- Scheduled jobs default to non-overlapping execution and a disposable session.
## 主界面挂饰与消息

- `pendant/frame-loop.ts` 独立负责可选 24/30/60 FPS 绘制调度（默认 30，旧配置自动兼容）：定时器临近截止时间再进入 RAF，保留非整除刷新率的小数节奏，高频输入合并唤醒；运行时切换只重排唯一待执行回调，不重建 WebGL/物理场景，休眠中切换不启动循环。隐藏/卸载取消计时器和 RAF。物理仍以 120 Hz 固定小步推进，停顿后不追赶后台时间。握持状态不再强制常驻循环，绳子平稳后可休眠，保持弹簧位置和储能，移动/松手重新唤醒。

- 绳子材质由 `strap-style.ts`（色阶与宽度）、`strap-geometry.ts`（沿曲线的织纹/交错绳股/双侧缝线）和 `strap.ts`（固定 SVG 节点池）分层负责。设置预览和材质小样用 `strap-preview.tsx` 复用同一几何；纹理沿弧长和切线排布，最多 256 个采样、8 层路径，不使用模糊滤镜、逐根绳股 DOM 或额外 GPU 贴图。颜色、线宽等属性只在外观或尺寸变化时更新，静止时沿用渲染器休眠。

- “卡片设置”位于定时任务之后，是独立工作区页面。`pendant/settings.ts` 负责设置校验，`use-settings.ts` 通过外部存储订阅统一管理当前浏览器的开关、材质、颜色和正面图片；跨标签同步，存储失败不覆盖已生效配置，未保存草稿不被其他标签覆盖。关闭会卸载挂饰、轮询和 GPU/物理资源，不影响服务端消息保留。
- `pendant/settings-panel.tsx` 复用工作区表单、提示与按钮；预览使用静态 SVG，不额外创建 WebGL。`strap-style.ts` 为预览与实际绳子提供同一套视觉参数，不改变物理参数。`card-image.ts` 本地验证和解码 PNG/JPEG/WebP（5 MB、2500 万像素上限），裁切为 512×704 JPEG（最多 700000 字符）再保存到 localStorage；不接收外链/SVG，不上传图片。替换纹理复用原画布，异步解码使用修订号避免旧图片覆盖新设置或卸载后更新。

- `pendant/widget.tsx` 通过 DSH `shell.overlay` 加法插槽提供单一挂饰，独立于会话和伙伴面板；不修改宿主布局或 DSH 源码。
- `pendant/renderer.ts` 是单独构建的同源 ESM 资源。使用 Three.js + Rapier 实现 React Bits Lanyard 风格交互，不是原组件的逐字移植；卡牌与纹理由插件生成，无外部模型/图片请求。渲染库打进独立资源，不成为用户安装时额外解析的运行时依赖。
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
