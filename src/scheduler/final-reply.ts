import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ScheduledPartnerTask } from './domain.js'
import { channelReplyPartsAfter, isInternalTaskNotice } from '../channels/delivery-policy.js'

/** Match the durable wake message, never a nearby user or another task's turn. */
export function continuationFinalReply(entries: ScheduledPartnerTask[], sessionId: string, history: readonly SessionEvent[], turn: readonly SessionEvent[], end: SessionEvent) {
  if (end.type !== 'turn/end' || end.data.reason.kind !== 'completed') return
  const origin = [...history].reverse().find(event => event.type === 'user/message'
    && (event.data.source.kind === 'user' || isInternalTaskNotice(event)))
  if (!origin || origin.type !== 'user/message' || !isInternalTaskNotice(origin)) return
  const entry = entries.find(item => item.continuation?.originSessionId === sessionId && item.continuation.messageId === origin.data.id)
  const wake = entry?.continuation
  if (!entry || !wake || wake.board || !['completed', 'blocked'].includes(wake.state)) return
  // Only this identified wake notice is excluded from the ordinary silence filter.
  const parts = channelReplyPartsAfter(turn.filter(event => event !== origin), -1, true)
  // Tool preambles may mention files; references alone are not a final answer.
  if (!parts.text) return
  return {id: entry.id, messageId: wake.messageId, reply: {key: `${sessionId}:${end.data.turn}`, ...parts}}
}
