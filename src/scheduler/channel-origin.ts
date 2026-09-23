import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession, PartnerState } from '../domain.js'
import type { ScheduleContinuation } from './domain.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import { questionOrigin } from '../channels/question-origin.js'

export function savedContinuationRoute(state: PartnerState, owner: string, wake: ScheduleContinuation): ChannelSession | undefined {
  if (wake.board || !wake.originChannel) return
  const saved = wake.originChannel
  const route = state.sessions.find(s => s.id === saved.routeId && s.channelId === saved.channelId && s.userId === saved.userId
    && s.companionId === owner && s.sessionId === wake.originSessionId && s.kind === 'channel')
  if (!route) throw new Error('长任务原渠道已移除或变更，保留投递记录，不自动切换渠道')
  return route
}

/** Unknown/browser origins stay local; only the exact wake inherits a saved channel. */
export function continuationChannelOrigin(state: PartnerState, owner: string, sessionId: string, events: readonly SessionEvent[]): ChannelSession | undefined {
  const origin = [...events].reverse().find(e => e.type === 'user/message' && (e.data.source.kind === 'user' || isInternalTaskNotice(e)))
  if (origin && isInternalTaskNotice(origin) && origin.type === 'user/message') {
    if (origin.data.source.kind !== 'plugin' || origin.data.source.form !== 'notice' || origin.data.source.summary !== '伙伴长任务续接') return
    const entry = state.schedules.find(s => s.companionId === owner && s.continuation?.originSessionId === sessionId && s.continuation.messageId === origin.data.id)
    if (!entry?.continuation || entry.continuation.state === 'cancelled') return
    return savedContinuationRoute(state, owner, entry.continuation)
  }
  return questionOrigin(sessionId, events, state.sessions.filter(s => s.companionId === owner))
}
