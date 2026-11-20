import { credentialKey, type CredentialProvider, type GrantRecord } from '@deepseek-ai/dsh-credentials'

import type { BiliCredential } from './channels/bilibili/client.js'

const BILI_SCOPE = 'dsh-partner-bilibili'
const SCOPE = 'dsh-partner-weixin'

export interface WeixinCredential {
  botToken: string
  baseUrl: string
}

export class PartnerCredentialVault {
  constructor(private readonly provider: CredentialProvider) {}

  async readBilibili(channelId: string): Promise<BiliCredential | undefined> {
    const record = await this.provider.readRecord(credentialKey(BILI_SCOPE, channelId))
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw Error('B 站凭据不可用')
    const value = record.payload as unknown as BiliCredential
    if (typeof value.session !== 'string' || typeof value.uid !== 'string' || typeof value.csrf !== 'string') throw Error('B 站凭据不可用')
    return value
  }

  async writeBilibili(channelId: string, credential: BiliCredential): Promise<void> {
    await this.provider.modifyRecord(credentialKey(BILI_SCOPE, channelId), async () => ({ kind:'grant',payload:{...credential} }))
  }

  async deleteBilibili(channelId: string): Promise<void> {
    await this.provider.deleteRecord(credentialKey(BILI_SCOPE, channelId))
  }

  async configured(channelId: string): Promise<boolean> {
    return (await this.provider.describeRecord(credentialKey(SCOPE, channelId))).configured
  }

  async read(channelId: string): Promise<WeixinCredential> {
    const record = await this.provider.readRecord(credentialKey(SCOPE, channelId))
    if (record === undefined || record.kind !== 'grant') throw new Error('微信渠道凭据不可用')
    const value = record.payload as Record<string, unknown>
    if (typeof value.botToken !== 'string' || typeof value.baseUrl !== 'string') throw new Error('微信渠道凭据格式无效')
    return { botToken: value.botToken, baseUrl: value.baseUrl }
  }

  async write(channelId: string, credential: WeixinCredential): Promise<void> {
    const record: GrantRecord = { kind: 'grant', payload: credential }
    await this.provider.modifyRecord(credentialKey(SCOPE, channelId), async () => record)
  }

  async delete(channelId: string): Promise<void> {
    await this.provider.deleteRecord(credentialKey(SCOPE, channelId))
  }
}
