import type { ChannelSession, Companion, PartnerState } from '../domain.js'
import { affectionEnabled, affectionProgress } from './affection.js'
import { affectionAudienceAllowed } from './affection-adapter.js'
import { idleContactRouteAllowed } from './idle-contact.js'
import { isSleeping } from './sleep.js'

/** Persist misses too: one opportunity per delivered user turn, including after restart. */
export interface PostReplyOpportunity {
  userMessageId: string
  sessionId: string
  policyRevision: number
  deliveredAt: number
  dueAt: number
  expiresAt: number
  probability: number
  status: 'pending' | 'missed' | 'claimed' | 'cancelled'
}
export function postReplyProbability(companion: Companion): number {
  return affectionEnabled(companion) ? 0.05 + 0.4 * (affectionProgress(companion.affection).score / 100) ** 2 : 0
}
export function postReplyAllowed(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now()): boolean {
  if (!companion.idleContact?.enabled || !affectionEnabled(companion) || route.companionId !== companion.id || isSleeping(companion, now) || !idleContactRouteAllowed(state, companion, route.id)) return false
  const channel = state.channels.find(c => c.id === route.channelId && c.companionId === companion.id)
  return (route.kind === 'local' || !!channel) && affectionAudienceAllowed({route, ...(channel ? {channel} : {})})
}
export function postReplyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now()): boolean {
  const pending = route.postReplyOpportunity
  return !!pending && pending.sessionId === route.sessionId && pending.policyRevision === companion.updatedAt
    && postReplyAllowed(state, companion, route, now)
}
/** Shared by generation, delivery and tool dispatch; revocation takes effect immediately. */
export function activityPolicyCurrent(state: PartnerState, companion: Companion, route: ChannelSession, now = Date.now()): boolean {
  if (!companion.idleContact?.enabled) return false
  return route.idleContactState?.kind === 'post-reply'
    ? postReplyCurrent(state, companion, route, now) && route.postReplyOpportunity?.status === 'claimed'
      && route.postReplyOpportunity.userMessageId === route.idleContactState.userMessageId
    : companion.idleContact.routeId === route.id
}
export const POST_REPLY_PROMPT = [
  '这是刚刚成功回复后的「主动延续」机会。上一条已经送达，不要重新回答、复述或解释刚才的答复。',
  '顺着真实话题和角色心情，判断现在是否自然想补一句、分享发现、发表情或语音，或做一件已授权的私有活动。可以只做自己的事，也可以不行动。好感度只影响获得这次机会的概率，不是要求你一定追加回复。',
  '先看用户是否表示告别、想安静或不想继续；遵守其意愿。没有具体新内容就用 partner_activity_finish 安静结束。不要凑第二条消息，不催回复，不为使用能力编造经历。',
].join('\n')
