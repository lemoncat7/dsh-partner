import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {isPluginSource} from './message-source.js'

const CONTEXT_SOURCES=new Set(['runtime-context','time-context','compact-checkpoint','system-prompt','model-selection','tool-registry','ptc-mode'])
/** Return only this execution's completed final answer. Bookkeeping is not new input. */
export function concernReplySummary(events:readonly SessionEvent[],messageId:string):string|undefined {
  let found=false,answer=''
  for(const event of events){
    if(event.type==='user/message'){
      const source=event.data.source
      if(source&&CONTEXT_SOURCES.has(source.kind))continue
      if(source&&isPluginSource(source,'@lemoncat7/dsh-partner')&&source.form==='notice'&&['伙伴附件交付','需求成果交付'].includes(source.summary??''))continue
      if(found)return undefined
      found=event.data.id===messageId
      continue
    }
    if(!found)continue
    if(event.type==='tool/call'||event.type==='tool/result')answer=''
    if(event.type==='assistant/message'&&!event.data.interrupted){
      answer=event.data.message.content.some(b=>b.type==='tool-call')?'':event.data.message.content.filter(b=>b.type==='text').map(b=>b.type==='text'?b.text:'').join('\n').trim()
    }
    if(event.type==='turn/end')return answer&&event.data.reason.kind==='completed'?answer.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu,'[凭据已隐藏]').replace(/(Bearer\s+)\S+/giu,'$1[凭据已隐藏]').slice(0,2000):undefined
  }
  return undefined
}
export function hasConcernReply(events:readonly SessionEvent[],messageId:string):boolean {return concernReplySummary(events,messageId)!==undefined}
