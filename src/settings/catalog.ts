import type { WorkspacePage } from '../ui/workspace-navigation.js'

export type IdentitySection = 'identity' | 'character' | 'relationship' | 'idle' | 'sleep'
export type CharacterSection = 'role' | 'chat' | 'trial'
export type MemorySection = 'learning' | 'window' | 'review' | 'renewal'
export type QqSection = 'chat' | 'voice' | 'capabilities' | 'home' | 'connection' | 'private' | 'group' | 'groups' | 'autonomy' | 'sessions' | 'media' | 'access' | 'send'

export type ChannelSetting =
  | { dialog: 'channel'; platform: 'qq' | 'matrix' | 'mattermost' | 'bilibili'; section?: QqSection }
  | { dialog: 'weixin' | 'tts' | 'browser' | 'delivery' | 'bark' }

export type SettingDestination =
  | { page: 'identity'; section: IdentitySection; character?: CharacterSection }
  | { page: 'weixin'; channel: ChannelSetting }
  | { page: 'memory'; section?: MemorySection }
  | { page: 'capabilities'; anchor?: string }
  | { page: WorkspacePage | 'concerns' | 'continuous' }

export interface SettingEntry {
  id: string
  title: string
  path: string
  terms: readonly string[]
  help: string
  destination: SettingDestination
  needsRole?: boolean
}
export interface SettingRequest { entry: SettingEntry; channelId?: string }
export interface SettingsGuideResult { answer: string; settingIds: string[] }

const identity = (section: IdentitySection, character?: CharacterSection): SettingDestination =>
  ({ page: 'identity', section, ...(character ? { character } : {}) })
const channel = (channel: ChannelSetting): SettingDestination => ({ page: 'weixin', channel })
const qq = (section: QqSection): SettingDestination => channel({ dialog: 'channel', platform: 'qq', section })
const memory = (section?: MemorySection): SettingDestination => ({ page: 'memory', ...(section ? { section } : {}) })
const entry = (id: string, title: string, path: string, destination: SettingDestination, help: string, terms: string[], needsRole = false): SettingEntry =>
  ({ id, title, path, destination, help, terms, ...(needsRole ? { needsRole } : {}) })

export const settingsCatalog: readonly SettingEntry[] = [
  entry('identity', '基本身份', '身份', identity('identity'), '编辑名字、职责和长期行为准则。', ['名字', '昵称', '身份', '行为准则', '定位', '改名']),
  entry('character', '角色设定', '身份 / 角色聊天', identity('character', 'role'), '编辑人格正文、对话示例和背景资料，也可以开启角色聊天。', ['角色聊天', '人设', '人格', '角色卡', '角色扮演', '性格', '提示词', '背景资料']),
  entry('chat-style', '聊天方式', '身份 / 角色聊天', identity('character', 'chat'), '调整闲聊节奏、分段、表情和私聊短句优先语音。', ['回复太长', '一句话', '短句', '分段', '表情包', '贴纸', '回复语气', '短句语音', '聊天节奏'], true),
  entry('character-trial', '角色试聊', '身份 / 角色聊天', identity('character', 'trial'), '在面板试聊当前编辑的角色，也可模拟 QQ 归属账号或群友。', ['试聊', '预览角色', '测试语气'], true),
  entry('relationship', '关系设定', '身份', identity('relationship'), '编辑专属称呼和相处方式。QQ 按归属账号应用。', ['称呼', '关系', '哥哥', '弟弟', '怎么叫我', '语气亲密'], true),
  entry('idle', '闲时自主活动', '身份', identity('idle'), '选择空闲时是否主动联系、目标会话和自主习惯。', ['主动找我', '主动聊天', '自主活动', '主动消息', '主动发消息', '空闲', '主动联系', '自主习惯'], true),
  entry('sleep', '睡眠与做梦', '身份', identity('sleep'), '管理角色的自主休息和做梦。', ['睡眠', '休息', '做梦', '安静时间'], true),
  entry('model', 'Preset 与模型', '能力组合', { page: 'capabilities', anchor: 'model' }, '选择伙伴新会话的默认模型和 Agent Preset。已有会话保留自身设置。', ['换模型', '模型', '供应商', '服务商', 'preset', '切模型']),
  entry('tool-discovery', '统一伙伴工具入口', '能力组合', { page: 'capabilities', anchor: 'tool-discovery' }, '管理伙伴自身工具是否通过统一入口发现。', ['按需加载工具', 'partner_tools', '工具入口', '隐藏工具']),
  entry('tools', '工作工具', '能力组合', { page: 'capabilities', anchor: 'tools' }, '启用伙伴的知识库、Skill、MCP、SSH 和 Git 能力。', ['工具权限', '知识库', 'ssh', 'git', '能力']),
  entry('companion-access', '伙伴协作授权', '能力组合', { page: 'capabilities', anchor: 'coordination' }, '设置伙伴间单向访问及委派任务权限。', ['协作授权', '委派给伙伴', '可访问伙伴', '跨伙伴']),
  entry('qq-connection', 'QQ 连接', '渠道 / QQ', qq('connection'), '配置 SnowLuma 正向 WebSocket，测试连接或重连。', ['接 qq', '连接 qq', 'qq', 'snowluma', 'onebot', 'websocket', 'qq 掉线']),
  entry('qq-private', 'QQ 私聊回复', '渠道 / QQ', qq('private'), '开启私聊回复，管理好友配对和审批。', ['私聊不回', '好友审批', '配对码', '私聊', '联系人']),
  entry('qq-group', 'QQ 群聊回复', '渠道 / QQ', qq('group'), '启用群聊回复，设置非自主回复群的触发方式。', ['开启群聊', '群聊回复', '群回复开关', '群消息']),
  entry('qq-groups', '选择 QQ 回复群', '渠道 / QQ / 群聊回复', qq('groups'), '选择允许伙伴回复的 QQ 群。', ['群白名单', '群组', '选群', '允许回复的群', '加群']),
  entry('qq-autonomy', 'QQ 自主回复', '渠道 / QQ / 群聊回复', qq('autonomy'), '先开启群聊回复并选中群，再将该群加入自主回复白名单。', ['不 @ 也回', '不用@', '不艾特', '不用艾特', '不提及也回', '艾特才回', '自主接话', '群不回复', '群不回', '自动接话', '@才回', '群聊自动回复']),
  entry('qq-account', 'QQ 归属账号', '渠道 / QQ / 访问权限', qq('access'), '绑定归属账号，让专属关系和该账号允许的私有能力生效。', ['归属账号', '谁是主人', '关系不生效', '账号绑定', '群里称呼']),
  entry('qq-voice', 'QQ 原生语音', '渠道 / QQ', qq('voice'), '管理 QQ 自带的语音回复和音色，私聊需要可用的音色来源群。', ['语音', '原生语音', '音色', 'qq语音', '发语音']),
  entry('qq-chat', 'QQ 聊天互动', '渠道 / QQ', qq('chat'), '设置公开聊天互动，包括戳一戳、表情等。', ['戳一戳', '表情回应', 'qq互动', '公开聊天能力']),
  entry('qq-media', 'QQ 表情与图片', '渠道 / QQ', qq('media'), '设置群聊图片、附件和表情包来源。', ['群里表情', 'qq表情包', '图片', 'qq收藏', '表情来源']),
  entry('qq-capabilities', 'QQ 私有能力', '渠道 / QQ', qq('capabilities'), '管理 QQ 空间、资料和群管理操作。', ['qq空间', '发说说', '说说', '动态', '群管理', '私有能力']),
  entry('qq-sessions', 'QQ 会话与记忆', '渠道 / QQ', qq('sessions'), '选择哪些 QQ 私聊或群使用伙伴的主会话。', ['qq记忆', '主会话', '独立会话', '共享会话', '群聊历史']),
  entry('weixin', '微信连接', '渠道', channel({ dialog: 'weixin' }), '扫码接入微信并管理联系人。', ['微信', '扫码', '微信配对']),
  entry('matrix', 'Matrix 连接', '渠道', channel({ dialog: 'channel', platform: 'matrix' }), '接入 Matrix 私聊渠道。', ['matrix']),
  entry('mattermost', 'Mattermost 连接', '渠道', channel({ dialog: 'channel', platform: 'mattermost' }), '接入 Mattermost 私聊渠道。', ['mattermost']),
  entry('bilibili', '哔哩哔哩渠道', '渠道', channel({ dialog: 'channel', platform: 'bilibili' }), '管理 B 站登录、内容浏览和互动权限。', ['哔哩哔哩', 'b站', 'bilibili', 'b站扫码']),
  entry('tts', '通用 TTS', '渠道 / 通用', channel({ dialog: 'tts' }), '先保存语音服务，再分配给对应渠道，可在页面试听。', ['tts', '语音', '发语音', '声音', '音色', '试听', 'BreezeBlue', '外部语音', '语音合成']),
  entry('browser', '浏览器', '渠道 / 通用', channel({ dialog: 'browser' }), '连接 Chrome / Chromium 的 CDP，设置外部访问地址与自主访问。', ['浏览器', '网页操作', 'chromium', 'chrome', 'cdp']),
  entry('delivery', '通知与交付', '渠道 / 通知', channel({ dialog: 'delivery' }), '选择任务完成通知和结果的接收渠道。', ['通知接收人', '任务交付', '发送给谁', '通知']),
  entry('bark', 'Bark 通知', '渠道 / 通知', channel({ dialog: 'bark' }), '管理 Bark 单向推送渠道。', ['bark', '手机推送', '推送通知']),
  entry('memory', '学习与记忆', '记忆 / 记忆设置', memory('learning'), '设置长期记忆、保留期限和记忆提炼模型。', ['学习', '记忆模型', '长期记忆', '保留时间', '记忆', '自动记住']),
  entry('memory-window', '滚动对话上下文', '记忆 / 记忆设置 / 对话窗口', memory('window'), '设置模型能看到的近期聊天轮数和字符预算。', ['滚动', '上下文', '历史很长', '对话窗口', '压缩', '聊天历史', '轮数'], true),
  entry('memory-review', '每日终审', '记忆 / 记忆设置', memory('review'), '开启学习后，可定时整理长期记忆。', ['整理记忆', '每日总结', '终审']),
  entry('memory-renewal', '上下文焕新', '记忆 / 记忆设置', memory('renewal'), '设置定时更新工作上下文的时间。开启滚动窗口会暂停焕新。', ['每天清空上下文', '重置上下文', '上下文焕新', '每日重置']),
  entry('memory-library', '记忆库与伙伴会话', '记忆', memory(), '查看记忆范围、会话记录以及整理状态。', ['查看记忆', '会话记录', '伙伴会话', '记忆库']),
  entry('concerns', '持续关注', '伙伴', { page: 'concerns' }, '查看持续关注的事项和观察状态。', ['监控变化', '关注', '追踪事项']),
  entry('continuous', '持续任务', '伙伴', { page: 'continuous' }, '查看、暂停或停止持续陪看任务。', ['持续陪看', '陪看', '持续任务', '一起看视频', '后台观看']),
  entry('skills', 'Skill 市场', '功能', { page: 'skills' }, '查找、安装和管理 Skill。', ['skill', '技能', '技能市场']),
  entry('mcp', 'MCP 服务', '功能', { page: 'mcp' }, '添加和管理 MCP 服务及其伙伴授权。', ['mcp', 'mcp服务器', 'mcp连接']),
  entry('board', '任务看板', '功能', { page: 'board' }, '查看需求、任务和协作交付。', ['看板', '工作进度', '需求']),
  entry('schedules', '定时任务', '功能', { page: 'schedules' }, '管理定时执行的计划。', ['定时', '计划任务', '每天执行', 'cron']),
  entry('pendant', '卡片设置', '工作区设置', { page: 'pendant' }, '设置伙伴挂件、卡片和通知显示。', ['挂件', '浮窗', '卡片外观']),
  entry('storage', '基本设置与存储', '工作区设置', { page: 'general' }, '查看伙伴数据、附件和存储迁移状态。', ['存储', '附件清理', '磁盘', '迁移', '空间占用']),
]

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

export function findSettings(query: string): SettingEntry[] {
  const value = normalize(query.trim())
  if (!value) return []
  return settingsCatalog.flatMap((row, index) => {
    const score = Math.max(...[row.title, ...row.terms].map(term => {
      const key = normalize(term)
      if (value === key) return 100
      if (key.length >= 2 && value.includes(key)) return 65 + Math.min(key.length, 20)
      return key.includes(value) ? 30 + value.length : 0
    }))
    return score ? [{ row, index, score }] : []
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(result => result.row)
}
