import { credentialKey, type CredentialProvider, type GrantRecord } from '@deepseek-ai/dsh-credentials'

const SCOPE = 'dsh-partner-weixin'

export interface WeixinCredential {
  botToken: string
  baseUrl: string
}

export class PartnerCredentialVault {
  constructor(private readonly provider: CredentialProvider) {}

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
