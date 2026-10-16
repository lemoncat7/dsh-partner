import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
export class PushCredentials {
  constructor(private readonly provider: CredentialProvider) {}
  async read(id: string): Promise<string> {
    const record = await this.provider.readRecord(credentialKey('dsh-partner-push', id))
    if (!record || record.kind !== 'grant' || typeof (record.payload as { key?: unknown }).key !== 'string') throw Error('推送凭据不可用，请重新保存设备 Key')
    return (record.payload as { key: string }).key
  }
  async write(id: string, key: string): Promise<void> { await this.provider.modifyRecord(credentialKey('dsh-partner-push', id), async () => ({ kind: 'grant', payload: { key } })) }
  async delete(id: string): Promise<void> { await this.provider.deleteRecord(credentialKey('dsh-partner-push', id)) }
}
