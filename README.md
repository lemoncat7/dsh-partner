# DSH Partner

面向 DeepSeek Harness 的长期 AI 伙伴与微信渠道插件。

伙伴不是一次会话中的临时提示词。每个伙伴拥有独立身份、Agent Preset、模型路由、能力声明，以及按微信联系人隔离的 DSH Session。第一版以微信为主要渠道，使用腾讯微信 iLink Bot API，不模拟个人微信网页版协议。

## 当前能力

- 伙伴创建、编辑与删除
- Agent scoped 身份提示，仅影响该伙伴创建的 Agent
- 为伙伴选择 Agent Preset、提供方与模型
- 微信 iLink Bot 扫码连接
- `bot_token` 只保存到 DSH Credential Store，管理 API 和浏览器均不返回
- 微信渠道启用、停用、断线退避与运行状态
- 私聊首次联系配对审批
- `微信机器人 + 联系人` 独立 Session 路由
- DSH Agent 完整回复后回发微信，并保留 iLink `context_token`
- 微信图片与文档双向收发：图片进入 DSH 原生附件上下文，文档安全保存到伙伴独立工作目录
- 伙伴可把工作目录内生成的图片、PDF、Office 文档及常用文本文件回发微信
- DSH 运行中发起选择题或自由提问时同步到微信；联系人回复序号、选项文字或自定义答案后，原 Agent 继续执行
- 微信在伙伴忙碌时遵循 DSH 全局 `ui-conversation.busyEnter`：`steer` 插入当前轮，`queue` 排入下一轮
- 按伙伴和微信联系人双重隔离的完整对话归档、每日回顾与结构化长期记忆
- 对话前按话题召回画像、偏好、任务、事件、关系与短期情绪信号
- 心跳上下文只注入当前 Agent 作用域的真实工具目录，不注入近期回顾、长期任务、偏好、情绪或其他记忆
- 心跳会在有限预算内从关注变化、学习新知和整理现状中发现并核实最多三条线索；只有产生可靠且有实际价值的信息才通过渠道通知
- 可配置静默时段、检查间隔、每日通知上限、失败退避和手动检查
- 修改伙伴身份或能力时清理该伙伴的渠道 Session，防止新旧人格串联
- Windows、macOS、Linux 兼容的原子状态写入

心跳默认关闭，升级后不会突然主动发送消息。群聊策略和多渠道适配尚未开放。

## 安装

```bash
dsh plugin --profile web add @lemoncat7/dsh-partner
```

本地压缩包：

```bash
dsh plugin --profile web add ./lemoncat7-dsh-partner-1.0.0.tgz
```

重启对应 DSH profile 后，左侧「空间」上方会出现「伙伴」。打开伙伴面板，创建或选择伙伴，再进入「微信」扫码。

## 默认配置

```yaml
- insert:
    - id: partner
      name: '@lemoncat7/dsh-partner'
      config:
        statePath: !!js dshHomePath('partner/state.json')
        exposeWeb: true
        apiPrefix: /partner-local/v1
        defaultCwd: ''
        autoStartChannels: true
```

`defaultCwd` 为空时使用 DSH 进程当前工作目录，以兼容桌面端和 Docker。可按部署情况显式设为真实存在的绝对路径。

## 微信流程

1. 插件请求 `/ilink/bot/get_bot_qrcode?bot_type=3`。
2. 页面每两秒检查二维码状态，确认后凭据直接进入 Credential Store。
3. 后台通过 `/ilink/bot/getupdates` 长轮询接收消息。
4. 未授权联系人只会创建配对请求。
5. 批准后，为该联系人创建或恢复独立 DSH Agent。
6. 收到图片时，插件通过微信 CDN 下载并解密媒体，保存到伙伴工作目录，同时作为 DSH 原生图片附件交给 Agent；文档保存后以安全路径交给 Agent。
7. Agent 使用伙伴身份和所选 Preset 运行，最终文本通过 `/ilink/bot/sendmessage` 返回微信；回复中明确引用的工作目录文件会加密上传并作为微信附件发送。

渠道身份只决定消息归属，不授予任何工具权限。SSH、知识库和未来 Git 插件仍执行各自的挂载、授权和审批规则。

## 数据与安全

- 普通状态：`statePath` 指向的 JSON 文件。
- 伙伴记忆：`<defaultCwd>/partners/<伙伴 ID>/memory/`，按联系人隔离保存每日完整对话归档、每日回顾和结构化长期记忆；相关记忆会在对话与心跳前按需召回，默认永久保留。
- 敏感凭据：DSH Credential Store，scope 为 `dsh-partner-weixin`。
- 管理 API：默认 `/partner-local/v1`，仅接受同源请求；写操作还要求 `X-DSH-Partner-Request: 1`。
- 微信机器人只能绑定一个伙伴；联系人上下文不会跨机器人、伙伴或其他联系人共享。
- 入站附件上限为 64 MB，保存在 `<伙伴 cwd>/inbound/`，目录权限为 `0700`、文件权限为 `0600`。
- 出站附件最多 8 个，只允许伙伴工作目录内的真实文件；会解析真实路径并拒绝符号链接越界、未知格式和超限文件。

## 开发

```bash
npm install
npm test
npm pack --dry-run
```

要求 Node.js `^22.19.0 || >=24.0.0`，与当前 DSH 运行时一致。
