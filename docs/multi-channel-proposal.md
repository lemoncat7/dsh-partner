# 伙伴多渠道接入方案（历史调研）

本文保留初始调研，不作为当前功能承诺。最终先实施 Matrix / Mattermost，且经用户确认，同一伙伴本地与渠道共用主对话；当前行为以 `direct-channels.md` 和 1.15.0 发布说明为准。

调研日期：2026-09-14。只做方案，不代表以下渠道已经在伙伴中实现。

## 1. 参考依据与支持范围

核对 NomiFun Desktop 提交 `c5461de6dc9df1845edd7956c3573029ae08f33e` 的渠道说明、插件注册表、ChannelPlugin 接口，以及补充平台的 plugin.rs。源码存在不等于本项目已完成真实账号联调；各平台的主动通知窗口、附件大小、机器人申请限制需在实施该适配器时再次核对官方文档。

- [渠道指南](https://github.com/nomifun/nomifun-desktop/blob/c5461de6dc9df1845edd7956c3573029ae08f33e/docs/guides/channels.zh.md)
- [适配器注册表](https://github.com/nomifun/nomifun-desktop/blob/c5461de6dc9df1845edd7956c3573029ae08f33e/crates/backend/nomifun-channel/src/plugins/mod.rs)
- [平台统一接口](https://github.com/nomifun/nomifun-desktop/blob/c5461de6dc9df1845edd7956c3573029ae08f33e/crates/backend/nomifun-channel/src/plugin.rs)

共 12 种内置适配器，默认构建启用；自定义构建可能裁剪。

| 平台 | 参考项目的接入方式 | 本项目建议 |
| --- | --- | --- |
| 微信 | 扫码登录、轮询 | 保留并先迁入新接口，验证无回归 |
| Telegram | Bot Token、长轮询 | 首批新增，先私聊 |
| 飞书（Lark） | App ID/Secret、WebSocket | 首批新增，先私聊；飞书与国际 Lark 的端点需显式区分 |
| 钉钉 | Client ID/Secret、Stream WebSocket | 第二批 |
| 企业微信 | 智能机器人 Bot ID/Secret、长连接 | 第二批；不是单向群 Webhook 或旧应用回调模式 |
| QQ Bot | 官方 AppID/Secret、Gateway WebSocket + REST | 第二批；不是个人 QQ 协议，受平台资质和授权范围约束 |
| Discord | Gateway + REST | 后续按使用需求排期 |
| Slack | Socket Mode + REST | 后续按使用需求排期 |
| Matrix | `/sync` 长轮询 | 后续；不能先承诺加密房间和可靠群类型识别 |
| Mattermost | WebSocket + REST | 后续 |
| Twitch | IRC over WebSocket | 后续；直播聊天室不等同于私聊助理 |
| Nostr | Relay WebSocket、NIP-04 私信 | 后续；密钥与协议能力需独立验收 |

NomiFun 指南明确：群策略选择器适用于飞书、钉钉、企业微信、QQ Bot、Discord、Slack、Mattermost；Telegram 的结构化提及尚未统一解析，Matrix 的私聊/群聊识别有局限。不能因为有适配器就显示所有功能开关。

## 2. 现有伙伴架构评估

可复用：渠道实例 ID、联系人审批、渠道会话、凭据服务、入站收据、部分持久化出站收据、任务/关注通知入口，以及 DSH 自身 Agent 与工具审批。

需解耦的位置：

- `domain.ts` 的 `channels` 仍是 `WeixinChannel[]`，没有平台判别字段。
- `credentials.ts` 固定微信 scope 和 botToken/baseUrl 格式。
- `channels/manager.ts` 同时承担微信轮询、媒体处理、配对、Agent 路由、问答和发送，多个路径直接 `new WeixinApi(...)`。
- `agent-runtime.ts` 与 memoryScope 当前以 channelId + userId 标识私聊，尚无独立群/话题定位。
- 页面、配对提示、附件默认名、诊断文案仍包含微信专用名称。不能全局替换“微信”：扫码和平台专用帮助必须保留。

结论：不需要另建 Agent 系统，但不是添加几个表单即可。参考接口和隔离原则，用 TypeScript 接入现有 DSH 服务，不引入整套 Rust 后端。若复用上游代码/资源，另行核对文件许可并保留适用的署名及 NOTICE。

## 3. 单一职责边界

入站：平台适配器 → 标准事件 → 去重/准入 → 会话路由 → 现有伙伴 Agent。
出站：回复/任务/关注 → 指定目的地的持久化发件箱 → 平台适配器。

- `channels/adapters/<platform>/`：凭据测试、平台事件转换、连接与重连、协议级收发、平台错误归类。不得决定工具权限或伙伴身份。
- `channels/registry.ts`：适配器注册与能力描述。按启用实例启动，不为未配置渠道建立连接。
- `channels/lifecycle.ts`：实例启停、健康状态、取消、独立退避；死连接不能仍显示在线。
- `channels/access.ts`：私聊审批、群准入、撤销校验；在创建会话和调用模型前执行。
- `channels/router.ts`：唯一伙伴归属与 conversation 地址映射，不以显示名称路由。
- `channels/inbox.ts`：事件收据和有界排队；同一会话顺序处理，不让长 Agent 回答阻塞整个平台收消息。
- `channels/outbox.ts`：每个目的地独立队列、限流、重试、发送回执和不确定交付状态。沿用并扩展现有收据，不另起一套并行交付系统。
- `channels/questions.ts`：交互按钮或文本问答回退；回调绑定渠道、发送者、会话、请求、有效期，拒绝伪造与重放。
- `ChannelManager`：仅组装服务与对外暴露兼容入口，逐步迁出平台逻辑。

统一事件至少包含 platform、channelId、eventId、senderId、conversationId、conversationKind、threadId（可选）、真实提及列表、文本、附件引用、replyTo 和时间。sender 与回复目的地是不同字段，不能再把 userId 当成所有平台的 chatId。

能力声明分开列出入站/出站图片和文件、消息编辑、按钮、输入状态、私聊/群聊、线程及主动发送限制。尚未实现的能力不显示为可用；不支持附件时明确报未交付，不能仿照默认空字符串回执静默成功。默认完成后发送整段文本，流式编辑按平台能力节流，不为渲染重复调用模型。

## 4. 身份、授权和稳定性

- 一个机器人实例只归属一个伙伴；同一平台可配置多个机器人。用平台和真实 bot ID 判重，不用名称或密钥判重。
- 每个渠道独立授权。同名联系人不能自动合并；微信审批不授予 Telegram 权限，渠道接入也不能扩大 DSH 工具范围。
- 首批仅开放已批准私聊。群聊后续显式启用，默认关闭；须可靠识别群及真实 @，不靠正文字符串判定。
- 群会话不得复用个人记忆、凭据、知识挂载或个人关注，也不能自动获得负责人能力。多人共享群的权限收敛方案单独验收后才开放。
- 旧微信 channelId、userId、sessionId、memoryScope、收据键和凭据引用保持不变。新平台采用版本化的结构化路由键，避免冒号拼接歧义；群/线程作为独立地址。
- 关注和任务发送到创建时明确绑定的目的地；不因新增渠道改发“最近活跃联系人”。多渠道广播必须额外明确授权。
- 鉴权失效暂停该实例；429 遵循 Retry-After；网络错误有限退避；永久错误不无限重试。平台要求交互窗口或 context token 时标为受限，不谎报通知成功。
- 超时且不确定是否已发送时保留 uncertain 状态，利用平台幂等键或回执查询；无法核实时不承诺 exactly-once。
- 暂停/删除/解绑使用实例 generation 和 AbortSignal，防止旧连接写回或转交消息给新伙伴。
- 入站附件先校验来源、类型、大小及下载超时；凭据不进普通 JSON、日志、模型上下文或 URL 展示。
- 代理支持按实例覆盖、默认继承部署配置，HTTP 与 WebSocket 一致生效；首批优先出站连接，不要求额外暴露公网端口。

## 5. 用户操作与迁移

伙伴的“微信”标签改为“渠道”。展示该伙伴已连接的机器人列表：平台、账号、状态、授权人数、测试/启停/管理入口；“添加渠道”按实际已实现适配器选择，不先摆一批不能用的按钮。

配置区分连接信息和授权管理，不在渠道表单复制一套伙伴模型/工具设置。微信继续扫码，新平台使用各自凭据字段。状态明确区分连接中、在线、重连、认证失效、受限、已停止；最近错误脱敏。

新增 platform 判别及配置版本，旧条目缺省为 weixin，迁移幂等。旧微信凭据 scope 保留兼容读取；新渠道写入独立命名空间。新类型存在后回滚旧版必须恢复升级前状态，禁止旧版静默忽略并重写新渠道数据。

## 6. 分阶段交付与验收

1. 框架：拆出适配接口和微信适配器，完成旧数据迁移及契约测试。微信连接、审批、文本、附件、询问用户、任务交付、关注提醒均不得退化。
2. 首批：Telegram 私聊 → 飞书私聊，逐个平台通过真实机器人收发、重启恢复及权限测试，再出正式版。
3. 第二批：钉钉、企业微信、QQ Bot；结合实际申请条件排期。
4. 按需求接 Discord、Slack 等；群聊、线程和跨平台主动广播另设验收，不夹带在私聊上线中。

测试必须覆盖：相同用户 ID 跨平台隔离；不同机器人互不串消息；未批准不创建 Agent；重复事件只执行一次；断网重连和游标恢复；一条渠道限流不影响其他渠道；有界积压；部分附件发送失败；权限撤销后队列不得继续发送；解绑竞态；代理；凭据脱敏；缺少能力时明确降级；旧微信数据往返迁移；主面板与右侧栏无回归。

真实联调需要用户在对应官方平台创建机器人并配置凭据；通过已有凭据界面输入，不把 Secret 贴入设计文档。当前尚未执行新渠道开发或线上迁移。首批建议 Telegram + 飞书，等待用户确认优先级。
