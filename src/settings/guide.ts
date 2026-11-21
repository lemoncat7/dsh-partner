import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { roleTextForCard } from '../character/domain.js'
import { qqSettings } from '../channels/qq/settings.js'
import type { Companion, ChannelView, PartnerState } from '../domain.js'
import { partnerSessionModel } from '../companions/session-model.js'
import { settingsCatalog, type SettingsGuideResult } from './catalog.js'

const guideRunning = new Set<string>()
const menu = settingsCatalog.map(({ id, title, path, help, terms, needsRole }) => ({ id, title, path, help, terms, ...(needsRole ? { needsRole } : {}) }))

export function settingsGuideFacts(
  companion: Companion,
  state: Pick<PartnerState, 'channels' | 'pairings'>,
  channelStatus: (id: string) => ChannelView['runtimeStatus'],
) {
  const card = companion.characterCard
  const { memory } = companion.automation
  const channels = state.channels.filter(item => item.companionId === companion.id).slice(0, 20)
  return {
    roleChat: card?.enabled === true,
    characterConfigured: Boolean(card && (roleTextForCard(card).trim() || card.lore.length)),
    relationshipConfigured: Boolean((companion.relationshipText ?? card?.relationship)?.trim()),
    chat: card && { length: card.length, segmented: card.segmentedReplies === true, shortVoice: card.shortVoiceReplies === true, stickers: card.stickersEnabled === true },
    idle: { enabled: companion.idleContact?.enabled === true, hasTarget: Boolean(companion.idleContact?.routeId), habits: companion.idleContact?.habitsEnabled === true },
    browser: { configured: Boolean(companion.browser), enabled: companion.browser?.enabled === true, autonomous: companion.browser?.autonomous === true },
    memory: { enabled: memory.enabled, rolling: memory.rollingContextEnabled === true, review: memory.dailyReviewEnabled, renewal: memory.contextRenewalEnabled !== false },
    ttsProfileCount: companion.ttsProfiles?.length ?? 0,
    capabilities: companion.capabilities,
    toolDiscovery: companion.toolDiscovery === true,
    channels: channels.map(channel => {
      const policy = channel.platform === 'qq' ? qqSettings(channel.qq) : undefined
      const profile = companion.ttsProfiles?.some(item => item.id === channel.tts?.profileId) ?? false
      return {
        platform: channel.platform ?? 'weixin', enabled: channel.enabled, status: channelStatus(channel.id),
        pendingContacts: state.pairings.filter(p => p.channelId === channel.id && p.status === 'pending').length,
        tts: { enabled: channel.tts?.enabled === true, profileExists: profile },
        ...(policy ? {
          qq: {
            privateReplies: policy.privateReplies, groupReplies: policy.groupReplies,
            selectedGroups: policy.groupIds.length, otherGroupTrigger: policy.groupTrigger,
            autonomousGroups: policy.autonomousGroupIds.filter(id => policy.groupIds.includes(id)).length,
            nativeVoice: policy.replyVoiceEnabled === true,
            nativePrivateVoiceHasSource: policy.groupIds.includes(policy.replyVoiceGroupId || policy.groupIds[0] || ''),
            ownerBound: policy.identityBinding?.enabled === true,
          },
        } : {}),
      }
    }),
  }
}

export function parseSettingsGuideReply(text: string): SettingsGuideResult {
  const value = JSON.parse(text.trim().replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, '')) as Partial<SettingsGuideResult> | null
  if (typeof value?.answer !== 'string' || !value.answer.trim() || !Array.isArray(value.settingIds)) {
    throw new Error('设置引导返回格式无效')
  }
  return {
    answer: value.answer.trim(),
    settingIds: [...new Set(value.settingIds.filter(id => menu.some(item => item.id === id)))].slice(0, 5),
  }
}

export async function explainSettings(
  ctx: Context, companion: Companion, question: string,
  facts: ReturnType<typeof settingsGuideFacts>, signal: AbortSignal, sessionId?: string,
): Promise<SettingsGuideResult> {
  if (guideRunning.has(companion.id) || guideRunning.size >= 3) throw new Error('设置引导正在生成，请稍后再试')

  guideRunning.add(companion.id)
  try {
    const system = [
      '你是伙伴控制面板的设置向导。根据设置目录和当前伙伴的配置状态，用用户的语言直接回答。',
      '先指出当前状态和最可能的缺项，再给简短的页面操作步骤。用户想要调整时说明建议的改动和它会影响什么，由用户在对应设置里保存。只能看输入里的信息，没有执行权限；不要声称已经修改、测试或发送。',
      'QQ 群回复要求开启群聊回复并选中群。希望不必 @ 且由伙伴判断何时接话，可把该群加入自主回复白名单。其他已选群由群聊回复的触发选项控制：mention 仅接收 @，all 可接收普通消息；成员仍须分别审批。当前状态只有各名单数量，无法知道指定群或成员是否已获许可。渠道启用通用 TTS 时优先走通用 TTS，缺少绑定音色时先修正绑定；配置存在不代表供应商或密钥已经验证。QQ 私聊原生语音需要可用的音色来源群。区分已配置、启用和在线。',
      '滚动对话窗口启用时会暂停每日上下文焕新。能力组合的模型仅作为伙伴新建会话的默认值，后台子智能体模型由 DSH 的子智能体插件管理。',
      '对未知状态明确说还需检查的项目。只引用目录中的页面，避免编造开关、路径和链接。输出 JSON 对象，answer 是简短纯文本，settingIds 是 0 到 5 个来自目录的设置 ID，按建议打开的顺序排列。',
    ].join('\n')
    const selection = await partnerSessionModel(ctx, companion, sessionId, signal)
    let output = '', finished = false
    for await (const chunk of ctx.llm.stream({
      ...selection, system, signal,
      messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ question, facts, settings: menu }) }], source: { kind: 'user' } })],
    })) {
      if (chunk.type === 'text-delta') {
        output += chunk.text
      }
      if (chunk.type === 'finish') finished = chunk.reason.kind === 'stop'
    }
    if (!finished) throw new Error('设置引导未完成')
    return parseSettingsGuideReply(output)
  } finally {
    guideRunning.delete(companion.id)
  }
}
