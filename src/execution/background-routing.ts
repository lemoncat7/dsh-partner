import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelSession,PartnerState} from '../domain.js'
import {actualAction} from '../chat/action-obligation.js'
import type {ExecutionRun} from './domain.js'
import {channelReplyAllowed,directReplyTarget} from '../channels/reply-access.js'
import {qqIdentityRelation} from '../channels/qq/identity-binding.js'
import {questionOrigin,webMessageRoute,attachedWebRoute} from '../channels/question-origin.js'
import {isInternalTaskNotice} from '../channels/delivery-policy.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {isLightweightLookup,needsTaskPreamble} from './task-preamble.js'
import {backgroundHandoff} from './background-receipt.js'

/** Match the current work to a real input, including a scheduler-issued activity notice. */
export function backgroundInput(events:readonly SessionEvent[]){
 for(let i=events.length-1;i>=0;i--){
  const e=events[i]!
  if(e.type==='turn/start'||isInternalTaskNotice(e))return
  if(e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))return e
 }
}
export function backgroundOrigin(sessionId:string,events:readonly SessionEvent[],routes:readonly ChannelSession[],input=backgroundInput(events)):ChannelSession|undefined {
 if(!input)return
 if(isIdleContactNotice(input))return routes.find(r=>r.sessionId===sessionId&&r.idleContactState?.messageId===input.data.id)
 return questionOrigin(sessionId,events,routes)??webMessageRoute(sessionId,events,routes,input.data.id)
}
export function backgroundRunRoute(routes:readonly ChannelSession[],run:ExecutionRun):ChannelSession|undefined {
 const b=run.background
 if(!b)return
 const candidate=routes.find(r=>r.id===b.routeId)??(b.sourceKind==='local'?attachedWebRoute(b.sourceSessionId,routes):undefined)
 if(candidate?.id===b.routeId&&candidate.sessionId===b.sourceSessionId&&candidate.companionId===run.ownerCompanionId&&candidate.userId===b.userId&&candidate.channelId===b.channelId)return candidate
}
/** Both execution and final delivery use the frozen origin, even after other speakers enter the session. */
export function backgroundSourceAllowed(state:PartnerState,run:ExecutionRun):boolean{
 const b=run.background
 if(!b)return false
 const c=state.companions.find(c=>c.id===run.ownerCompanionId)
 const route=backgroundRunRoute(state.sessions,run)
 if(!c||!route||b.capabilities.some(cap=>!c.capabilities.includes(cap as never)))return false
 if(b.audience==='activity'){
  if(!c.characterCard?.enabled||route.idleContactState?.messageId===b.inputId&&route.idleContactState.cancelled)return false
  if(b.activityKind==='continuous'?!c.browser?.autonomous:!c.idleContact?.enabled)return false
 }
 if(b.sourceKind==='local')return route.kind==='local'
 const ch=state.channels.find(c=>c.id===b.channelId&&c.companionId===run.ownerCompanionId)
 if(route.kind!=='channel'||!ch?.enabled||ch.accountId!==b.accountId||(ch.direct?.baseUrl??'')!==b.baseUrl||directReplyTarget(state,b.channelId,b.userId)!==b.targetId||!channelReplyAllowed(state,b.channelId,b.userId,b.targetId))return false
 return ch.platform!=='qq'||b.audience==='member'||b.audience==='activity'||!!qqIdentityRelation(ch.qq,b.userId)?.matched
}
const control=new Set(['job_list','job_output','job_kill','terminal_open','terminal_read','terminal_list','terminal_signal','terminal_close','partner_background_task','partner_memory_recall','partner_tools','partner_channel_access','partner_stickers','partner_voice_reply','partner_qq_reply','partner_send_attachment','partner_activity_finish','partner_continuous_task','partner_schedule','partner_task','partner_task_board','partner_requirement','partner_collaborate'])
function work(name:string,args:Record<string,any>):boolean {
 if(control.has(name)||name==='partner_browser'&&['status','recent','tabs'].includes(args.action))return false
 return needsTaskPreamble(name,args)
}
function substantial(name:string,args:Record<string,any>):boolean {
 return ['subagent','subagent_fork','spawn_agent','fork_agent','generate_image','edit_image','image_gen.imagegen','bash','exec','exec_command','terminal','run_code','write','edit','str_replace_editor','ssh','ssh_exec','ssh_terminal_open','ssh_terminal_send','partner_browser','partner_work_execute'].includes(name)
  ||['run','execute'].includes(args.action)
}
export function backgroundWork(name:string,args:unknown):boolean {const action=actualAction(name,args);return work(action.name,action.args)}
/** Keep lookups in the chat and hand executable or continuing work to the background. */
export function backgroundRequired(name:string,args:unknown,events:readonly SessionEvent[],callId?:string):string|undefined {
 const action=actualAction(name,args)
 if(!work(action.name,action.args))return
 let start=-1
 for(let i=events.length-1;i>=0;i--){const e=events[i]!;if(e.type==='turn/start'||isInternalTaskNotice(e))return;if(e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e))){start=i;break}}
 if(start<0)return
 const tail=events.slice(start+1)
 if(backgroundHandoff(tail))return '当前任务已由后台接收，前台不能重复执行'
 // Native Jobs already runs this operation outside the conversation driver.
 // It needs no second model or child Session, and retains native job controls.
 if(['bash','terminal_send'].includes(action.name)&&action.args.run_in_background===true)return
 // Publishing prepared content is a single foreground delivery, even after lookups.
 // Keep the handoff guard above: an accepted background task still owns its work.
 if(action.name==='partner_qq'&&action.args.action==='call'&&action.args.operation==='send_qzone_msg')return
 if(isLightweightLookup(action.name,action.args))return
 if(substantial(action.name,action.args))return '这是执行型任务，必须先交原生后台'
 // Discovery, denied attempts and bounded lookups do not count as completed work.
 const failedDispatches=new Set(tail.flatMap(e=>e.type==='tool/ptc-dispatch'&&e.data.isError?[e.data.parentCallId]:[]))
 const completed=new Set(tail.flatMap(e=>e.type==='tool/result'&&!e.data.message.isError?[e.data.message.toolCallId]:[]))
 let calls=0
 for(const e of tail){
  if(e.type!=='tool/call'||e.data.callId===callId||!completed.has(e.data.callId)||failedDispatches.has(e.data.callId))continue
  const c=actualAction(e.data.name,e.data.arguments)
  if(!work(c.name,c.args)||isLightweightLookup(c.name,c.args))continue
  calls++
  if(calls>=2)return '本轮已有多步实际执行，后续工作必须先交原生后台'
 }
}
