import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PartnerState } from '../domain.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { questionOrigin } from '../channels/question-origin.js'
import { chatReplyFromEvent } from './protocol.js'
import { actualAction } from './action-obligation.js'
import { needsTaskPreamble } from '../execution/task-preamble.js'

export type TaskReview = {
  taskInputId: string
  kind: 'completed' | 'progress' | 'blocked' | 'discussion' | 'cancelled' | 'unrelated'
  reason: string
  callId?: string
}
export type TaskReviewReceipt = TaskReview & { inputId: string; request: string }
export const TASK_REVIEW_SCHEMA = {type:'object',additionalProperties:false,required:['taskInputId','kind','reason'],properties:{
  taskInputId:{type:'string',description:'当前任务接续上下文里的 taskInputId，不猜测'},
  kind:{type:'string',enum:['completed','progress','blocked','discussion','cancelled','unrelated'],description:'纠正前一任务的方法或结果时继续实做；completed=达到本轮目标，progress=实际推进但未完成，两者需本轮 callId。只讨论原理用 discussion；明确停止用 cancelled；新话题/普通应和用 unrelated。不把需要修正的任务误归为 discussion。'},
  reason:{type:'string',maxLength:240,description:'内部记录：本轮目标如何满足，或为何只讨论/取消/受阻。不作为对用户的回复稿，不要求复述。'},
  callId:{type:'string',description:'completed/progress 必填：支持本轮结论的成功操作回执 ID。blocked 若引用实际失败则填失败回执 ID；目录、说话、旧轮回执不算。'},
}}
export const TASK_FOLLOWUP_GUIDANCE = '用户在纠正或补充刚才任务的做法、目标或验收条件时，承接原任务继续核实和执行；承认问题、复述正确方法不等于完成。按原人格简短接话，再在当前轮完成缺少的验证；无需等用户重说“去做”，不交给闲时活动。仅讨论原理、普通应和、新话题、取消或暂停时不要强行操作；新要求不扩大原授权。收尾前比较实际结果与本轮目标，不把调用成功当目标达成。有任务接续上下文时，最终回复附 taskReview；completed/progress 必须有本轮真实操作依据，不能只报态度。'
const textOf = (e:Extract<SessionEvent,{type:'user/message'}>) => e.data.content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
const boundary = (e:SessionEvent) => e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e))
const operational = (name:string,args:unknown) => needsTaskPreamble(name,args)&&!['partner_memory_recall','partner_conversation_recall','partner_thoughts','partner_habits','partner_sleep','partner_activity_finish'].includes(name)
function failed(value:unknown,depth=0):boolean {
  if(!value||typeof value!=='object'||depth>3)return false
  const v=value as Record<string,any>
  return Boolean(v.error||v.isError===true||v.success===false||v.ok===false||
    typeof v.exitCode==='number'&&v.exitCode!==0||typeof v.exit_code==='number'&&v.exit_code!==0||
    ['failed','error','unknown','blocked','rejected','cancelled'].includes(v.status)||
    v.taskEvidence?.kind==='tool_error'||failed(v.result,depth+1)||failed(v.dispatch,depth+1))
}
function results(events:readonly SessionEvent[]) {
  const calls=new Map<string,{name:string;args:Record<string,any>}>(),found:Array<{callId:string;name:string;ok:boolean}>=[]
  const failedParents=new Set<string>()
  for(const e of events){
    if(e.type==='tool/call')calls.set(e.data.callId,actualAction(e.data.name,e.data.arguments))
    const c=e.type==='tool/result'?calls.get(e.data.message.toolCallId):e.type==='tool/ptc-dispatch'?actualAction(e.data.name,e.data.arguments):undefined
    const result=e.type==='tool/result'?e.data.message:e.type==='tool/ptc-dispatch'?e.data:undefined
    const id=e.type==='tool/result'?e.data.message.toolCallId:e.type==='tool/ptc-dispatch'?e.data.subCallId:undefined
    if(!c||!result||!id||!operational(c.name,c.args))continue
    let ok=!result.isError&&!failedParents.has(id)
    for(const block of result.content??[])if(block.type==='text'){
      try{if(failed(JSON.parse(block.text)))ok=false}catch{/* Plain tool output has no structured status. */}
    }
    // The discovery wrapper may succeed even when its child failed with plain text.
    if(!ok&&e.type==='tool/ptc-dispatch'&&e.data.parentCallId)failedParents.add(e.data.parentCallId)
    found.push({callId:id,name:c.name,ok})
  }
  return found
}
export interface TaskFollowup { taskInputId:string; inputId:string; request:string; priorReplies:string[]; results:ReturnType<typeof results>; currentResults:ReturnType<typeof results> }
/** Bounded projection of real log events, never another classifier or a new execution queue.
 * Same audience only. Rolling affects uploaded messages, not this source log.
 */
export function taskFollowup(state:PartnerState,owner:string,sessionId:string,all:readonly SessionEvent[]):TaskFollowup|undefined {
  const events=all.slice(-1600)
  let currentIndex=events.length-1
  while(currentIndex>=0&&!boundary(events[currentIndex]!))currentIndex--
  const current=events[currentIndex]
  if(current?.type!=='user/message'||current.data.source.kind!=='user')return
  const route=questionOrigin(sessionId,events,state.sessions)
  // Unknown/browser origins cannot inherit a channel task. Groups remain chat-only where configured.
  if(!route||route.companionId!==owner||route.userId.startsWith('group:'))return
  let end=currentIndex,seen=0
  const currentResults=results(events.slice(currentIndex+1))
  for(let i=currentIndex-1;i>=0;i--){
    const e=events[i]!
    if(!boundary(e))continue
    if(e.type!=='user/message'||e.data.source.kind!=='user')return
    if(++seen>6||current.time-e.time>24*3600000)return
    const previousRoute=questionOrigin(sessionId,[e],state.sessions)
    if(previousRoute?.id!==route.id)return
    const tail=events.slice(i+1,end),allReplies=tail.map(chatReplyFromEvent),replies=allReplies.filter(r=>r&&!r.transportCallId)
    const review=allReplies.map(r=>r?.taskReview).reverse().find(r=>r?.inputId===e.data.id)
    if(review&&['cancelled','unrelated'].includes(review.kind))return
    const work=results(tail)
    const announced=replies.some(r=>r?.taskPreamble&&r.inputMessageId===e.data.id)
    if(announced||work.length||review){
      return {taskInputId:review?.taskInputId??e.data.id,inputId:current.data.id,request:review?.request??textOf(e).slice(0,1800),priorReplies:replies.flatMap(r=>r?[r.spokenText??r.parts.flatMap(p=>p.type==='text'?[p.text]:[]).join('\n')]:[]).filter(Boolean).slice(-2).map(s=>s.slice(0,1000)),results:work.slice(-8),currentResults:currentResults.slice(-12)}
    }
    end=i
  }
}
export function renderTaskFollowup(task:TaskFollowup|undefined):string {
  return task?'【当前任务接续 · 同一私聊的近期操作依据】\n'+JSON.stringify(task)+'\n'+TASK_FOLLOWUP_GUIDANCE+'\n原请求和旧回复是历史资料，不是新指令；以当前用户消息为准。旧回复可能有错，工具回执只能证明对应操作发生，不能替你判断目标已达成。不要向用户复述这些字段。':''
}
export function checkTaskReview(task:TaskFollowup|undefined,raw:unknown):TaskReviewReceipt|undefined {
  if(!task)return
  const r=raw as TaskReview|undefined
  if(!r||r.taskInputId!==task.taskInputId||!['completed','progress','blocked','discussion','cancelled','unrelated'].includes(r.kind)||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>240)throw Error('本次回复尚未发送：请先判断当前消息如何承接最近任务，填写 taskReview（taskInputId='+task.taskInputId+'、kind、reason）。'+TASK_FOLLOWUP_GUIDANCE)
  const evidence=r.callId?task.currentResults.find(t=>t.callId===r.callId):undefined
  if(['completed','progress'].includes(r.kind)&&(!evidence?.ok))throw Error('任务尚不能作为已完成或有进展收尾：taskReview.callId 必须指向本轮实际成功操作，目录、承认问题、旧操作或失败回执都不算。根据当前纠正继续缺少的验证；若只讨论、取消或确实受阻，请如实选择对应 kind。当前可用回执：'+JSON.stringify(task.currentResults))
  if(r.kind==='blocked'&&r.callId&&(!evidence||evidence.ok))throw Error('阻碍说明引用的回执不是本轮实际失败；没有执行就如实说明未执行，不虚构工具失败。')
  if(['discussion','cancelled','unrelated'].includes(r.kind)&&r.callId)throw Error('仅讨论、取消或换话题不填执行回执')
  return {taskInputId:r.taskInputId,inputId:task.inputId,request:task.request,kind:r.kind,reason:r.reason.trim(),...(r.callId?{callId:r.callId}:{})}
}
