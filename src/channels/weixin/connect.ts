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
  const previous = state.channels.find(c => isWeixin(c) && c.companionId === login.companionId)
  const validate = (current: typeof state) => {
    if (store.isCompanionRemoving(login.companionId) || !current.companions.some(c => c.id === login.companionId)) throw httpError(409, '伙伴已删除或正在删除，请重新选择伙伴')
    if (current.channels.some(c => isWeixin(c) && c.accountId === login.accountId && c.companionId !== login.companionId)) throw httpError(409, '此微信机器人已绑定其他伙伴，请为新伙伴使用独立机器人，不能重复绑定')
    if (previous && previous.accountId !== login.accountId) throw httpError(409, '请扫描原微信机器人的二维码登录；不能将已有联系人授权转给不同机器人')
    if (current.channels.some(c => isWeixin(c) && c.companionId === login.companionId && c.id !== previous?.id)) throw httpError(409, '此伙伴已连接微信，请刷新后重新扫码')
    if (previous && !current.channels.some(c => c.id === previous.id)) throw httpError(409, '原渠道已删除，请刷新后重试')
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
