import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../store.js'
import { questionOrigin } from '../channels/question-origin.js'
import { canFinishIdleActivity } from './activity-tool.js'
import { habitsEnabled, habitRoute, habitScope, visibleHabits, observeHabit } from './habits.js'
const substantive=(tools:Array<{name:string;ok:boolean}>)=>tools.some(t=>t.ok&&!/^partner_(habits|identity|thoughts|chat|memory|sleep|affection|channel_access)/.test(t.name))
export function habitTool(owner:string,store:PartnerStore):ToolDefinition {
 return {name:'partner_habits',description:'查看自主习惯，或在自主活动中依据已完成的自身活动记录形成兴趣候选、删除过时兴趣。不修改角色正文。inspect 返回可引用来源id。聊天形成的习惯由后台检查；不能把私聊内容转成全局偏好。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['inspect','observe','remove']},id:{type:'string'},text:{type:'string',maxLength:120},sourceId:{type:'string'},evidence:{type:'string',maxLength:180}}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:String(v)}]},async execute(raw,exec){
  const a=raw as {action:string;id?:string;text?:string;sourceId?:string;evidence?:string},agent=exec.agent
  if(!agent)throw Error('仅限伙伴会话')
  const state=store.snapshot(),c=state.companions.find(c=>c.id===owner),route=questionOrigin(agent.session.id,agent.session.snapshotEvents(),state.sessions)??state.sessions.find(r=>r.kind==='local'&&r.sessionId===agent.session.id&&r.companionId===owner)
  if(!c||!habitRoute(state,c,route))throw Error('当前会话不可用')
  if(a.action==='inspect')return JSON.stringify({enabled:habitsEnabled(c),habits:visibleHabits(c,habitScope(route)).map(({baseline,evidence,...h})=>h),sources:(c.activityJournal??[]).filter(j=>j.sessionId===agent.session.id&&substantive(j.tools)&&Date.now()-j.at<7*86400000).slice(-8).map(j=>({id:j.id,summary:j.summary,tools:j.tools})),policy:'活动来源只能形成不含人名、私事、会话内容的抽象兴趣。三次独立依据且跨六小时才生效，未满为候选。角色正文优先。'})
  if(!['observe','remove'].includes(a.action))throw Error('习惯操作无效')
  await store.update(s=>{
   exec.signal.throwIfAborted();const live=s.companions.find(c=>c.id===owner)
   if(!live||store.isCompanionRemoving(owner)||!habitsEnabled(live)||!canFinishIdleActivity(owner,s,agent.session.id,agent.session.snapshotEvents()))throw Error('只能在已授权的自主活动中整理兴趣')
   const source=live.activityJournal?.find(j=>j.id===a.sourceId&&j.sessionId===agent.session.id&&substantive(j.tools)&&Date.now()-j.at<7*86400000)
   if(!source||!a.evidence||!source.summary.includes(a.evidence))throw Error('请引用已完成活动记录中的真实依据')
   const changed=observeHabit(live,'global',{action:a.action,id:a.id,text:a.text,kind:'interest'},{id:'activity:'+source.id,at:source.at,excerpt:a.evidence})
   live.habitCheck={at:Date.now(),outcome:changed?'changed':'unchanged',reason:changed?'依据自身活动整理了兴趣候选':'暂无新的独立依据'}
  })
  return JSON.stringify({saved:true,message:'习惯已检查，未修改角色正文，不需要向聊天对象汇报。'})
 }}
}
