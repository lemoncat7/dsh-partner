import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelSession} from '../domain.js'
import {actualAction} from '../chat/action-obligation.js'
import {questionOrigin} from '../channels/question-origin.js'
import {isInternalTaskNotice} from '../channels/delivery-policy.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {needsTaskPreamble} from './task-preamble.js'
import {backgroundHandoff} from './background-receipt.js'

export function backgroundOrigin(sessionId:string,events:readonly SessionEvent[],routes:readonly ChannelSession[]):ChannelSession|undefined {
 const last=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isInternalTaskNotice(e)||isIdleContactNotice(e)))
 if(last?.type!=='user/message'||last.data.source.kind!=='user')return
 return questionOrigin(sessionId,events,routes)??routes.find(r=>r.sessionId===sessionId&&r.kind==='local')
}
const control=new Set(['partner_background_task','partner_memory_recall','partner_tools','partner_channel_access','partner_stickers','partner_voice_reply','partner_qq_reply','partner_send_attachment','partner_activity_finish','partner_continuous_task','partner_schedule','partner_task','partner_task_board','partner_requirement','partner_collaborate'])
function work(name:string,args:Record<string,any>):boolean {
 if(control.has(name)||name==='partner_browser'&&['status','recent','tabs'].includes(args.action))return false
 return needsTaskPreamble(name,args)
}
function substantial(name:string,args:Record<string,any>):boolean {
 return ['subagent','subagent_fork','spawn_agent','fork_agent','generate_image','edit_image','image_gen.imagegen','bash','exec','exec_command','terminal','run_code','write','edit','str_replace_editor','ssh','ssh_exec','ssh_terminal_open','ssh_terminal_send','partner_browser','partner_work_execute'].includes(name)
  ||['run','execute'].includes(args.action)
}
export function backgroundWork(name:string,args:unknown):boolean {const action=actualAction(name,args);return work(action.name,action.args)}
/** A lightweight lookup is allowed; declared multi-tool work and continued workflows must hand off. */
export function backgroundRequired(name:string,args:unknown,events:readonly SessionEvent[],callId?:string):string|undefined {
 const action=actualAction(name,args)
 if(!work(action.name,action.args))return
 let start=-1
 for(let i=events.length-1;i>=0;i--){const e=events[i]!;if(e.type==='user/message'&&e.data.source.kind==='user'){start=i;break}}
 if(start<0)return
 const tail=events.slice(start+1)
 if(backgroundHandoff(tail))return '当前任务已由后台接收，前台不能重复执行'
 let calls=0,multistep=false
 for(const e of tail){
  if(e.type!=='tool/call'||e.data.callId===callId)continue
  const c=actualAction(e.data.name,e.data.arguments)
  if(['partner_chat_say','partner_chat_progress'].includes(c.name)&&c.args.beforeTools!==false&&Array.isArray(c.args.expectedTools)&&new Set(c.args.expectedTools).size>1)multistep=true
  if(work(c.name,c.args))calls++
 }
 if(substantial(action.name,action.args)||multistep||calls>=2)return '这是执行型或连续多步工作，必须先交原生后台'
}
