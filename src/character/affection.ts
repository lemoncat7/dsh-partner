import type { Companion } from '../domain.js'

/** One relationship progression per companion, shared by all eligible audiences. */
export interface AffectionState { score: number; updatedAt: number; lastAwardAt: number; lastTurnId: string }
export const AFFECTION_INITIAL = 20
export const AFFECTION_INTERVAL = 10 * 60_000
export const AFFECTION_LEVELS = [
  { min: 0, name: '相识', behavior: '自然接话，有具体话题时主动分享。' },
  { min: 20, name: '熟悉', behavior: '更愿意分享兴趣、日常感想和轻松的玩笑。' },
  { min: 40, name: '亲近', behavior: '更愿意主动找话题、分享发现，按语境使用表情。' },
  { min: 60, name: '信赖', behavior: '更愿意延续共同话题、主动关心，合适时使用已开启的语音。' },
  { min: 80, name: '默契', behavior: '更自然地表达牵挂、分享心事，主动使用适合当前相处的已授权互动能力。' },
] as const
export function affectionEnabled(companion: Pick<Companion,'characterCard'>): boolean {
  return companion.characterCard?.enabled===true && companion.characterCard.affectionEnabled!==false
}
export function affectionProgress(state?: AffectionState) {
  const score=Number.isFinite(state?.score)?Math.max(0,Math.min(100,Math.round(state!.score))):AFFECTION_INITIAL
  const index=Math.min(AFFECTION_LEVELS.length-1,Math.floor(score/20)),level=AFFECTION_LEVELS[index]!
  const next=AFFECTION_LEVELS[index+1]
  return {score,level:index+1,name:level.name,behavior:level.behavior,nextName:next?.name??null,nextAt:next?.min??100,remaining:next?next.min-score:0,multiplier:1+score/100,updatedAt:state?.updatedAt??0}
}
export function awardAffection(companion: Companion, turnId: string, at: number): boolean {
  if(!affectionEnabled(companion)||!turnId||!Number.isFinite(at)||at<=0)return false
  const previous=companion.affection
  if(previous&&(previous.lastTurnId===turnId||at-previous.lastAwardAt<AFFECTION_INTERVAL))return false
  const score=affectionProgress(previous).score
  if(score>=100)return false
  companion.affection={score:score+1,updatedAt:at,lastAwardAt:at,lastTurnId:turnId}
  // Progress is runtime state; do not invalidate identity drafts or rebuild tools.
  return true
}
export function affectionMultiplier(companion: Companion, eligible: boolean): number {
  return eligible&&affectionEnabled(companion)?affectionProgress(companion.affection).multiplier:1
}
export function renderAffection(companion: Companion, eligible: boolean): string {
  if(!eligible||!affectionEnabled(companion))return ''
  const p=affectionProgress(companion.affection)
  return `【当前共同好感度】${p.score}/100 · Lv.${p.level} ${p.name}。\n${p.behavior}\n这是本伙伴与适用对象共用的互动进度，QQ 多个归属账号共用；它不证明不同账号是同一人，不共享或编造他们各自的经历。保持原角色和关系，不因低等级疏远、不因高等级强制亲昵。好感度影响互动意愿，不解锁工具或绕过权限；尊重对方当下意愿，不催回复、不为加分重复联系，也不要求用户取悦你。无需在聊天中报告分数。`
}
