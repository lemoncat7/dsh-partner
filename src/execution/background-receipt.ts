import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {actualAction} from '../chat/action-obligation.js'
/** Only a successful tool receipt transfers foreground obligations; the model's words cannot. */
export function backgroundHandoff(events:readonly SessionEvent[]):boolean {
 const calls=new Map<string,boolean>()
 for(const e of events){
  if(e.type==='tool/call'){const c=actualAction(e.data.name,e.data.arguments);calls.set(e.data.callId,c.name==='partner_background_task'&&c.args.action==='start')}
  const result=e.type==='tool/result'?e.data.message:e.type==='tool/ptc-dispatch'?e.data:undefined
  const c=e.type==='tool/ptc-dispatch'?actualAction(e.data.name,e.data.arguments):undefined
  if(!result||result.isError||!(e.type==='tool/result'?calls.get(e.data.message.toolCallId):c?.name==='partner_background_task'&&c.args.action==='start'))continue
  for(const b of result.content??[])if(b.type==='text')try{
   const v=JSON.parse(b.text)
   if(v?.kind==='partner-background-v1'&&typeof v.taskId==='string'&&['queued','running','completed'].includes(v.status))return true
  }catch{/* A plain failure or unstructured text never accepts a task. */}
 }
 return false
}
