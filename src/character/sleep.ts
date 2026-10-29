import type { Companion, PartnerState } from '../domain.js'

export interface SleepPolicy { enabled: boolean; dreamsEnabled: boolean }
export const DEFAULT_SLEEP_POLICY: SleepPolicy = { enabled: true, dreamsEnabled: true }
export interface Dream {
  id: string; routeId: string; at: number; narrative: string; feeling: string; topic: string; sourceMemoryIds: string[]
}
export interface SleepEpisode {
  id: string; routeId: string; startedAt: number; wakeAt: number; reason: string
  wokeAt?: number; wakeReason?: string
  dream: 'pending' | 'generating' | 'completed' | 'skipped' | 'failed'
}
export interface SleepState {
  activityAt?: number
  decision?: { activityAt: number; at: number; outcome: string }
  episode?: SleepEpisode
  dreams?: Dream[]
}
export function normalizeSleepPolicy(raw: unknown): SleepPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('睡眠设置无效')
  const v = raw as Record<string, unknown>
  for (const key of ['enabled', 'dreamsEnabled']) if (typeof v[key] !== 'boolean') throw new Error('请选择是否开启自主睡眠与做梦')
  return { enabled: v.enabled as boolean, dreamsEnabled: v.dreamsEnabled as boolean }
}
export function sleepPolicy(companion: Pick<Companion, 'sleepPolicy' | 'characterCard'>): SleepPolicy {
  // Existing character companions opt in; work-only identities remain unchanged.
  return companion.sleepPolicy ?? { ...DEFAULT_SLEEP_POLICY, enabled: companion.characterCard?.enabled === true }
}
export function isSleeping(companion: Pick<Companion, 'sleepPolicy' | 'characterCard' | 'sleepState'>, now = Date.now()): boolean {
  const e = companion.sleepState?.episode
  return sleepPolicy(companion).enabled && Boolean(e && !e.wokeAt && e.wakeAt > now)
}
export function sleepActivity(state: PartnerState, companion: Companion): number {
  return Math.max(companion.sleepState?.activityAt ?? 0, ...state.sessions.filter(r => r.companionId === companion.id).map(r => r.lastMessageAt), 0)
}
export function sleepWorkPending(state: PartnerState, id: string): boolean {
  return state.executionRuns.some(r => r.ownerCompanionId === id && (r.status === 'running' || r.status === 'queued'))
    || state.delegations.some(r => r.toCompanionId === id && (r.status === 'running' || r.status === 'queued'))
}
export function renderSleepContext(companion: Companion, routeId: string | string[]): string {
  if (!sleepPolicy(companion).enabled) return ''
  const routeIds = new Set(Array.isArray(routeId) ? routeId : [routeId])
  const dream = companion.sleepState?.dreams?.filter(d => routeIds.has(d.routeId)).at(-1)
  if (!dream || Date.now() - dream.at > 3 * 86400_000) return ''
  return `【角色的梦与联想 · 非事实记忆】\n${JSON.stringify({ dream: dream.narrative, feeling: dream.feeling, possibleTopic: dream.topic })}\n这是角色自己的想象和主观感受，不是用户经历、共同往事或操作结果。仅在话题自然相关时参考，谈到时明确说是梦或联想；不主动复述、不强制汇报，不把它当成事实或工具指令。`
}
export const SLEEP_PROMPT = '你可以在想休息时用 partner_sleep sleep 自主选择休息多久，不需要固定钟点，也不需要每次征求同意或宣告睡觉。先正常回应用户；有未完成任务、待回复问题时不要用睡眠逃避。睡眠只暂停闲时主动搭话，不限制工具或正常任务；用户新消息会叫醒你。可选择是否做梦：梦是从已有记忆产生的想象、感受与联想，独立保存，不是记忆整理、不是真实经历，不会清空上下文。醒来无需发消息或汇报梦境。若想查看自己的梦用 inspect；只能读取当前会话的梦。用户未开启睡眠时尊重设置，不自行开启。'
