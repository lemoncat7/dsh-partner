/** Single-direction channels share delivery semantics, not chat pairing. */
export interface PushTarget { id: string; name: string; enabled: boolean; credentialId: string; fingerprint: string }
export interface PushChannel {
  id: string; companionId: string; platform: 'bark'; name: string; baseUrl: string
  enabled: boolean; revision: number; createdAt: number; updatedAt: number
  targets: PushTarget[]
  notifyProblems: boolean; content: 'summary' | 'title'; group: string; sound: string; openUrl: string
}
export interface PushEvent {
  id: string; companionId: string; title: string; text: string; createdAt: number
  outcome: 'completed' | 'problem'
}
export interface PushDelivery {
  id: string; companionId: string; eventId: string; channelId: string; targetId: string; revision: number
  title: string; body: string; createdAt: number; updatedAt: number; nextAttemptAt: number; expiresAt?: number
  status: 'pending' | 'sending' | 'accepted' | 'failed' | 'canceled'; attempts: number; lastError?: string
}
export type PushChannelView = Omit<PushChannel, 'targets'> & {
  targets: Array<Pick<PushTarget, 'id' | 'name' | 'enabled'> & { configured: boolean }>
  pending: number; failed: number; lastDelivery?: Pick<PushDelivery, 'status' | 'updatedAt' | 'lastError'>
}
export interface PushAdapter {
  send(channel: PushChannel, deviceKey: string, payload: { title: string; body: string }, signal: AbortSignal): Promise<void>
}

export function pushSummary(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' [代码或内容详见会话] ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/^[\s#>*-]+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 500)
}
