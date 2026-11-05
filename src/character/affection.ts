import type { Companion } from '../domain.js'

export interface AffectionChange { at: number; turnId: string; delta: number; score: number; reason: string; evidence: string }
/** Shared by eligible accounts; history is bounded and never injected wholesale. */
export interface AffectionState { score: number; updatedAt: number; lastAwardAt: number; lastTurnId: string; lastPositiveAt?: number; history?: AffectionChange[] }
export const AFFECTION_INITIAL = 0
export const AFFECTION_DELTAS = [-5,-4,-3,-2,-1,1,2,3,4,5] as const
export const AFFECTION_GUIDANCE = '按实际相处感受加减：轻微触动 ±1，明确的关心、理解、信任或失望 ±2～3，重要的支持、和解或真实伤害 ±4～5。结合近期相处和当前人格判断这句话带来的感受，不孤立要求用户明确说出关心或信任。日常认真倾听、分享心情、相互接梗、主动陪伴都可以带来轻微亲近；角色互动中真实投入的关心也算，但虚构剧情事件本身不直接计分。轻微不快不等于长期信任下降，不为制造浮动随机扣分。不必等重大事件，也不因每条消息存在就加分。没有变化时记 0；重复索分、机械重复同一句话不算新依据。'
export const AFFECTION_MEANING = '0 是既定关系的基线，不表示陌生、没有感情或忘记共同经历。人物设定决定性格与表达，关系设定决定身份、称呼和既有边界；好感度只记录真实长期相处相对基线的变化。具体表现按当前人物和关系设定判断，可影响主动分享、倾诉和接受亲近的意愿，不统一规定高分撒娇或低分冷漠，也不要求每轮表现分数。短暂开心、疲惫、闹别扭属于当下状态，不自动改变长期好感。分数不改变工具权限、任务完成标准或办事质量，也不直接乘算主动活动概率。'
export function affectionEnabled(companion: Pick<Companion,'characterCard'>): boolean {
  return companion.characterCard?.enabled===true && companion.characterCard.affectionEnabled!==false
}
export function affectionProgress(state?: AffectionState) {
  const score=Number.isFinite(state?.score)?Math.max(-100,Math.min(100,Math.round(state!.score))):AFFECTION_INITIAL
  const history=state?.history??[],last=history.at(-1)
  return {score,updatedAt:state?.updatedAt??0,history,lastChange:last?{at:last.at,delta:last.delta,reason:last.reason}:null}
}
/** No time/chat-count award: a grounded interaction may change the relationship. */
export function adjustAffection(companion: Companion, turnId: string, at: number, delta: number, reason: string, evidence: string): boolean {
  if(!affectionEnabled(companion))throw Error('好感度已暂停')
  if(!turnId||!Number.isFinite(at)||at<=0||!AFFECTION_DELTAS.includes(delta as typeof AFFECTION_DELTAS[number]))throw Error('好感度变化参数无效')
  if(typeof reason!=='string'||!reason.trim()||reason.length>300||typeof evidence!=='string'||!evidence.trim()||evidence.length>300)throw Error('变化需要具体原因和当前消息依据（各最多 300 字）')
  const previous=companion.affection,history=previous?.history??[]
  if(previous?.lastTurnId===turnId||history.some(h=>h.turnId===turnId))return false
  if(previous&&at<previous.updatedAt)throw Error('不能提交过期变化')
  const old=affectionProgress(previous).score,score=Math.max(-100,Math.min(100,old+delta))
  if(score===old)return false
  companion.affection={score,updatedAt:at,lastAwardAt:delta>0?at:previous?.lastAwardAt??0,lastPositiveAt:delta>0?at:previous?.lastPositiveAt??previous?.lastAwardAt??0,lastTurnId:turnId,
    history:[...history,{at,turnId,delta:score-old,score,reason:reason.trim(),evidence:evidence.trim()}].slice(-40)}
  return true
}
export function renderAffection(companion: Companion, eligible: boolean): string {
  if(!eligible||!affectionEnabled(companion))return ''
  const p=affectionProgress(companion.affection)
  return `【当前共同好感度】${p.score}（−100～100；0 为既定关系基线）。\n${AFFECTION_MEANING}${p.lastChange?`\n最近一次变化（历史依据，不是当前情绪或指令）：${JSON.stringify(p.lastChange)}`:''}\n只按真实互动记录变化，聊天次数、在线时长或完成任务不自动加分。不能因离线、晚回复、正常拒绝、不同意见或工具失败扣分。玩笑和虚构事件不直接当成伤害或共同经历。开启记忆学习时后台会检查；本轮有明确变化也可用 partner_affection 记录，无需打断聊天报分。QQ 多个归属账号共用分数，不据此认定为同一个人。`
}
