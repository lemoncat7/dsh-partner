import {backgroundHandoff} from '../execution/background-receipt.js'
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
  kind: 'completed' | 'progress' | 'repair' | 'blocked' | 'discussion' | 'cancelled' | 'unrelated'
  reason: string
  callId?: string
  remaining?: string
}
export type TaskReviewReceipt = TaskReview & { inputId: string; request: string; goalTools?:string[] }
export const TASK_REVIEW_SCHEMA = {type:'object',description:'近期任务的内部处理决定，不对外播报。上下文出现近期任务时，最终回复需说明已完成、受阻、只讨论、取消或换话题；需补救用 repair/progress 并 continueTurn:true。普通无任务聊天无需填写。',additionalProperties:false,required:['taskInputId','kind','reason'],properties:{
  taskInputId:{type:'string',description:'当前任务接续上下文里的 taskInputId，不猜测'},
  kind:{type:'string',enum:['completed','progress','repair','blocked','discussion','cancelled','unrelated'],description:'completed=原目标及本次纠正已满足，progress=已推进但仍待做，两者需本轮成功 callId；repair=确认需补救尚未执行。repair/progress 填 remaining 且 continueTurn:true，在本轮继续做。blocked=具体条件阻止继续；discussion=用户仅要事实/解释，不要修改；cancelled=明确停止；unrelated=换话题或普通应和。用户指出成果遗漏通常是修正原任务，不缩成只查原因，也不把情绪反馈当成取消。'},
  reason:{type:'string',maxLength:240,description:'内部记录：本轮目标如何满足，或为何只讨论/取消/受阻。不作为对用户的回复稿，不要求复述。'},
  remaining:{type:'string',maxLength:240,description:'repair/progress 必填：原目标还缺的具体动作或交付；blocked 可记待解决缺口。不把道歉、等待用户催促或闲时兴趣当成任务步骤。'},
  callId:{type:'string',description:'completed/progress 必填：支持本轮结论的成功操作回执 ID。blocked 若引用实际失败则填失败回执 ID；目录、说话、旧轮回执不算。'},
}}
export const TASK_FOLLOWUP_GUIDANCE = '这是同一对象的近期任务资料，不是新的执行授权。按当前消息判断：指出遗漏、不符合要求或对该结果失望时，在原授权内继续补救，不能把原目标缩成查明原因后道歉；查到问题不等于修正成果。先按人物简短接话，需继续则 continueTurn:true、taskReview.kind=repair/progress、remaining 写具体缺口，实际完成后再收尾。缺参考/文件先查询已有记录和可用来源，不用虚构替代品冒充；确实找不到就说明具体缺项。只询问原因且不需改、明确停止、换话题或普通应和，可分别 discussion/cancelled/unrelated 结束，不强迫执行旧工作。最终收尾填写 taskReview，内部决定不复述到聊天；补救不交给 interest/nextActivity，不受兴趣次数限制。已确认成功的外部发布、发送、付款等不盲目重做；需新增授权或来源不足就 blocked。语气及长短仍只遵循当前人物和聊天设置。'
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
export interface TaskFollowup { goalTools?:string[]; pending?:string; taskInputId:string; inputId:string; request:string; priorReplies:string[]; results:ReturnType<typeof results>; currentResults:ReturnType<typeof results> }
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
    // Exclude autonomous work without losing the preceding user's goal.
    if(isIdleContactNotice(e)){end=i;continue}
    if(e.type!=='user/message'||e.data.source.kind!=='user')return
    if(++seen>6||current.time-e.time>24*3600000)return
    const previousRoute=questionOrigin(sessionId,[e],state.sessions)
    if(previousRoute?.id!==route.id)return
    const tail=events.slice(i+1,end),allReplies=tail.map(chatReplyFromEvent),replies=allReplies.filter(r=>r&&!r.transportCallId)
    const review=allReplies.map(r=>r?.taskReview).reverse().find(r=>r?.inputId===e.data.id)
    if(review&&['cancelled','unrelated','discussion'].includes(review.kind))return
    if(backgroundHandoff(tail))return
    const work=results(tail)
    const announced=replies.some(r=>r?.taskPreamble&&r.inputMessageId===e.data.id)
    if(announced||work.length||review&&['progress','repair','blocked'].includes(review.kind)){
      const latest=events.slice(currentIndex+1).map(chatReplyFromEvent).map(r=>r?.taskReview).reverse().find(r=>r?.inputId===current.data.id)??review
      return {goalTools:review?.goalTools??work.filter(r=>r.ok&&!inspection(r.name)).map(r=>r.name).filter((n,i,all)=>all.indexOf(n)===i).slice(-8),...(latest?.remaining&&['progress','repair','blocked'].includes(latest.kind)?{pending:latest.remaining}:{}),taskInputId:review?.taskInputId??e.data.id,inputId:current.data.id,request:review?.request??textOf(e).slice(0,1800),priorReplies:replies.flatMap(r=>r?[r.spokenText??r.parts.flatMap(p=>p.type==='text'?[p.text]:[]).join('\n')]:[]).filter(Boolean).slice(-2).map(s=>s.slice(0,1000)),results:work.slice(-8),currentResults:currentResults.slice(-12)}
    }
    // A finished conversational reply ends the short-lived task projection.
    // Do not skip it and resurrect older work from the log.
    if(allReplies.some(r=>r&&!r.intermediate)||tail.some(e=>e.type==='assistant/message'&&!e.data.interrupted&&e.data.message.content.some(b=>b.type==='text'&&b.text.trim())&&!e.data.message.content.some(b=>b.type==='tool-call')))return
    end=i
  }
}
export function renderTaskFollowup(task:TaskFollowup|undefined):string {
  // A compact candidate is evidence, not an instruction to resume automatically.
  if(!task)return ''
  // Do not repeat the assistant's old explanations in every new request.
  const {priorReplies:_,...facts}=task
  return '【近期任务 · 先判断本次是否纠正或延续】\n'+JSON.stringify(facts)+'\n'+TASK_FOLLOWUP_GUIDANCE
}
export function checkTaskReview(task:TaskFollowup|undefined,raw:unknown,options?:{continuing:boolean}):TaskReviewReceipt|undefined {
  if(!task)return
  if(raw===undefined){if(options&&!options.continuing)throw Error('最终回复尚未发送：请用 taskReview 区分原任务已修正、受阻、仅讨论、停止或换话题。若仍能补救，先 continueTurn:true 再继续实际工作，不用兴趣续接代替。taskInputId='+task.taskInputId);return}
  const r=raw as TaskReview|undefined
  if(!r||r.taskInputId!==task.taskInputId||!['completed','progress','repair','blocked','discussion','cancelled','unrelated'].includes(r.kind)||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>240)throw Error('任务记录格式不正确；请填写正确的 taskReview（taskInputId='+task.taskInputId+'、kind、reason）。'+TASK_FOLLOWUP_GUIDANCE)
  if(r.remaining!==undefined&&(typeof r.remaining!=='string'||!r.remaining.trim()||r.remaining.length>240))throw Error('remaining 需为 1–240 字的具体任务缺口')
  if(r.kind==='repair'&&!r.remaining?.trim())throw Error('repair 必须记录 remaining，不能只道歉或解释')
  if(options&&['repair','progress'].includes(r.kind)&&(!options.continuing||!r.remaining?.trim()))throw Error('补救尚未完成，不能最终收尾或移交自主活动。填写 remaining 并 continueTurn:true，接着执行；确实受阻才用 blocked。')
  const evidence=r.callId?task.currentResults.find(t=>t.callId===r.callId):undefined
  if(['completed','progress'].includes(r.kind)&&(!evidence?.ok))throw Error('任务尚不能作为已完成或有进展收尾：taskReview.callId 必须指向本轮实际成功操作，目录、承认问题、旧操作或失败回执都不算。根据当前纠正继续缺少的验证；若只讨论、取消或确实受阻，请如实选择对应 kind。当前可用回执：'+JSON.stringify(task.currentResults))
  if(r.kind==='completed'&&evidence&&inspection(evidence.name)&&(task.goalTools??task.results.filter(r=>r.ok&&!inspection(r.name))).length>0)throw Error('本轮只有查看记录或检查的证据，尚不足以确认原成果已修正；不能把查明原因当作完成。继续实际补救；如果用户明确只要解释，用 discussion。')
  if(r.kind==='blocked'&&r.callId&&(!evidence||evidence.ok))throw Error('阻碍说明引用的回执不是本轮实际失败；没有执行就如实说明未执行，不虚构工具失败。')
  if(['discussion','cancelled','unrelated'].includes(r.kind)&&r.callId)throw Error('仅讨论、取消或换话题不填执行回执')
  return {taskInputId:r.taskInputId,inputId:task.inputId,request:task.request,goalTools:task.goalTools??task.results.filter(r=>r.ok&&!inspection(r.name)).map(r=>r.name),kind:r.kind,reason:r.reason.trim(),...(r.callId?{callId:r.callId}:{}),...(r.remaining?{remaining:r.remaining.trim()}:{})}
}

const inspection=(name:string)=>['read','glob','grep','rg','ls','read_image','web_search','web_fetch','partner_conversation_recall','partner_memory_recall'].includes(name)

/** Only the immediate, same-audience task candidate changes presentation. */
export function withTaskReviewSchema<T extends {name:string;parameters:unknown}>(tool:T,task:TaskFollowup|boolean|undefined):T{
 if(!task||tool.name!=='partner_chat_reply')return tool
 const schema=tool.parameters as Record<string,unknown>
 return {...tool,parameters:{...schema,required:[...new Set([...(Array.isArray(schema.required)?schema.required:[]),'taskReview'])]}}
}
