import type { ToolAccessAdapter } from '../../execution/tool-access-adapter.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PartnerState } from '../../domain.js'
import { isInternalTaskNotice } from '../delivery-policy.js'
import { isIdleContactNotice } from '../../character/idle-contact.js'
import { currentQqIdentityRelation } from './identity-binding.js'

const autonomousAgents = new WeakSet<object>()
/** Only internal schedulers can mark an execution; message text cannot. */
export function markAutonomousAgent(agent: object): () => void {
  autonomousAgents.add(agent)
  return () => { autonomousAgents.delete(agent) }
}

export const QQ_CHAT_ONLY_REASON = '当前 QQ 账号未归属此伙伴，仅允许当前会话的文字、表情与语音回复；不能使用私有能力、修改设定或触发自主任务。'

/** Re-evaluate at dispatch, so stale schemas and saved revocations cannot authorize work. */
export function qqChatOnly(agent: Pick<Agent, 'session'>, state: Pick<PartnerState, 'sessions' | 'channels'>): boolean {
  if (autonomousAgents.has(agent)) return false
  const routes = state.sessions.filter(r => r.sessionId === agent.session.id)
  if (!state.channels?.some(c => c.platform === 'qq' && routes.some(r => r.channelId === c.id))) return false
  const events = agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'user/message') continue
    // Only trusted plugin notices can run autonomous work. A group observation
    // remains an ordinary user's message even when the bot chooses to answer.
    if (isInternalTaskNotice(event)) return false
    if (isIdleContactNotice(event)) return !routes.some(r => r.idleContactState?.messageId === event.data.id)
    if (event.data.source.kind === 'user') break
  }
  const relation = currentQqIdentityRelation(agent.session.id, events, state.sessions, state.channels)
  return Boolean(relation && !relation.matched)
}

export const qqToolAccessAdapter: ToolAccessAdapter = {
  resolve({ agent, state }) {
    if (!state.channels?.some(c => c.platform === 'qq' && state.sessions.some(r => r.sessionId === agent.session.id && r.channelId === c.id))) return undefined
    return qqChatOnly(agent, state) ? { sendTools: true, allowedTools: ['partner_tools', 'partner_channel_access', 'partner_chat_reply', 'partner_stickers', 'partner_qq_reply'], denialReason: QQ_CHAT_ONLY_REASON } : { sendTools: true }
  },
}
