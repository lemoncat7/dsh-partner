import { randomUUID } from 'node:crypto'
import type { PartnerStore } from '../../store.js'
import type { PartnerCredentialVault } from '../../credentials.js'
import type { ChannelManager } from '../manager.js'
import type { ConfirmedLogin } from './login.js'
import { httpError } from '../../api/http.js'

/** Reauthentication preserves channel identity and approved contacts. */
export async function connectWeixin(login: ConfirmedLogin, runtime: {
  store: PartnerStore; credentials: PartnerCredentialVault; channels: ChannelManager
}) {
  const { store, credentials, channels } = runtime
  const state = store.snapshot()
  const isWeixin = (c: typeof state.channels[number]) => !c.platform || c.platform === 'weixin'
  const owned = state.channels.filter(c => isWeixin(c) && c.companionId === login.companionId)
  if (!login.channelId && owned.length > 1) throw httpError(409, '存在多个历史微信渠道，请在对应渠道上重新扫码')
  const previous = login.channelId ? owned.find(c => c.id === login.channelId) : owned[0]
  if (login.channelId && !previous) throw httpError(409, '指定微信渠道不存在或不属于此伙伴，请刷新后重试')
  const validate = (current: typeof state) => {
    if (store.isCompanionRemoving(login.companionId) || !current.companions.some(c => c.id === login.companionId)) throw httpError(409, '伙伴已删除或正在删除，请重新选择伙伴')
    if (current.channels.some(c => isWeixin(c) && c.accountId === login.accountId && c.companionId !== login.companionId)) throw httpError(409, '此微信机器人已绑定其他伙伴，请为新伙伴使用独立机器人，不能重复绑定')
    if (previous && previous.accountId !== login.accountId) throw httpError(409, '请扫描原微信机器人的二维码登录；不能将已有联系人授权转给不同机器人')
    if (current.channels.some(c => isWeixin(c) && c.companionId === login.companionId && c.id !== previous?.id && (!previous || c.enabled))) throw httpError(409, '此伙伴已有其他微信渠道启用，请先停用其他渠道，再重新扫码')
    if (previous && !current.channels.some(c => c.id === previous.id && c.companionId === login.companionId && c.accountId === previous.accountId && isWeixin(c))) throw httpError(409, '原渠道已删除或变更，请刷新后重试')
  }
  validate(state)
  const now = Date.now()
  const channel = previous ? { ...previous, enabled: true, updatedAt: now } : {
    id: `weixin-${randomUUID()}`, companionId: login.companionId, accountId: login.accountId,
    name: `微信 · ${login.accountId.slice(-6)}`, enabled: true, createdAt: now, updatedAt: now,
  }
  const oldCredential = previous ? await credentials.read(previous.id) : undefined
  if (previous) await channels.stop(previous.id)
  try {
    await credentials.write(channel.id, { botToken: login.botToken, baseUrl: login.baseUrl })
    await store.update(draft => {
      validate(draft)
      if (previous) Object.assign(draft.channels.find(c => c.id === previous.id)!, channel)
      else draft.channels.push(channel)
    })
  } catch (error) {
    if (oldCredential) await credentials.write(channel.id, oldCredential)
    else await credentials.delete(channel.id)
    if (previous?.enabled) await channels.start(previous.id)
    throw error
  }
  await channels.start(channel.id)
  return channel
}
