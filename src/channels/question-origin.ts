import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession } from '../domain.js'
import { isInternalTaskNotice } from './delivery-policy.js'

/** A binding is not an origin. Unknown/browser messages always stay in DSH. */
export function questionOrigin(sessionId: string, events: readonly SessionEvent[], routes: readonly ChannelSession[]): ChannelSession | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (isInternalTaskNotice(event)) return undefined
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    return routes.find(route => route.sessionId === sessionId && route.kind === 'channel' && route.inboundMessageIds?.includes(event.data.id))
  }
  return undefined
}
