import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../store.js'
import type { PartnerCredentialVault } from '../credentials.js'
import { directConfig } from './direct/transport.js'
import { updateDirectAvatar } from './direct/avatar.js'
import { readAvatarImage } from './avatar-file.js'

/** One service owns serialization and live authorization; credentials never enter tool results. */
export class ChannelAvatarService {
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(private readonly store: PartnerStore, private readonly credentials: PartnerCredentialVault) {}

  tool(companionId: string): ToolDefinition {
    const service = this
    return {
      name: 'partner_channel_avatar',
      description: '伙伴默认可用：修改自己的 Matrix / Mattermost 渠道账号头像。先 list 查看可修改渠道，再 set 提供 channelId 和当前会话目录内的真实 PNG/JPEG 图片 path（最多 2 MB）。账号级修改影响该账号全部会话，不是房间头像或 DSH 卡片图案。不支持微信、不改其他伙伴、禁止跨伙伴共用账号修改。不自动生成或下载 URL，必须以 updated=true 为成功依据。',
      parameters: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['list', 'set'] }, channelId: { type: 'string' }, path: { type: 'string' } }, required: ['action'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      presentCall: () => ({ card: 'generic', title: '伙伴渠道头像' }),
      async execute(raw, exec) {
        const input = raw as { action?: unknown; channelId?: unknown; path?: unknown }
        const agent = exec.agent
        if (!agent || !input || typeof input !== 'object') throw new Error('头像修改需要当前伙伴会话')
        const authorize = (): void => {
          exec.signal.throwIfAborted()
          const state = service.store.snapshot()
          if (!state.companions.some(companion => companion.id === companionId) || service.store.isCompanionRemoving(companionId)
            || !state.sessions.some(route => route.sessionId === agent.session.id && route.companionId === companionId)) throw new Error('伙伴已删除、正在删除或会话不属于当前伙伴')
        }
        authorize()
        const owned = service.store.snapshot().channels.filter(channel => channel.companionId === companionId && (channel.platform === 'matrix' || channel.platform === 'mattermost'))
        if (input.action === 'list') return JSON.stringify({ channels: owned.map(channel => ({ channelId: channel.id, name: channel.name, platform: channel.platform, accountId: channel.accountId, enabled: channel.enabled })), scope: '账号级头像，跨伙伴共用账号禁止修改' })
        if (input.action !== 'set' || typeof input.channelId !== 'string' || typeof input.path !== 'string') throw new Error('set 需要 channelId 和本地图片 path')
        const channel = owned.find(item => item.id === input.channelId)
        if (!channel || !channel.enabled || !channel.direct) throw new Error('渠道不存在、未启用或不属于当前伙伴')
        const cwd = agent.session.header.cwd
        if (!cwd) throw new Error('当前会话缺少工作目录')
        const key = `${channel.platform}:${channel.direct.baseUrl}:${channel.accountId}`
        const previous = service.queues.get(key) ?? Promise.resolve()
        const path = input.path
        const job = previous.catch(() => {}).then(async () => {
          const guard = (): void => {
            authorize()
            const state = service.store.snapshot(), current = state.channels.find(item => item.id === channel.id)
            if (!current?.enabled || current.companionId !== companionId || current.platform !== channel.platform || current.accountId !== channel.accountId || current.direct?.baseUrl !== channel.direct?.baseUrl) throw new Error('渠道配置已变化，头像未继续更新')
            if (state.channels.some(other => other.companionId !== companionId && other.platform === channel.platform && other.accountId === channel.accountId && other.direct?.baseUrl.replace(/\/$/, '') === channel.direct?.baseUrl.replace(/\/$/, ''))) throw new Error('该账号被其他伙伴共用，修改头像会影响其他伙伴；请先使用独立账号')
          }
          guard()
          const image = await readAvatarImage(cwd, path, exec.signal)
          const credential = await service.credentials.read(channel.id)
          const config = directConfig({ platform: channel.platform, baseUrl: credential.baseUrl, targetId: '' })
          if (config.baseUrl !== channel.direct!.baseUrl.replace(/\/$/, '')) throw new Error('渠道地址和凭据地址不一致，请重新配置')
          const result = await updateDirectAvatar(config, credential.botToken, channel.accountId, image, exec.signal, guard)
          return JSON.stringify({ updated: true, channelId: channel.id, platform: channel.platform, ...result, scope: 'account' })
        })
        service.queues.set(key, job)
        try { return await job } finally { if (service.queues.get(key) === job) service.queues.delete(key) }
      },
    }
  }
}
