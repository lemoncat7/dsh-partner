import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import type {ExecutionRun} from './domain.js'
import {inputOrigin} from '../channels/input-origin.js'
import {memoryTerms} from '../memory-retrieval.js'

export const MAX_BACKGROUND_RETRIES=2
export type BackgroundRetryMode='resume'|'images'|'manifest'

export function retryMode(reason:string):BackgroundRetryMode|undefined {
 if(/maximum\s+\d+\s*MiB|payload too large|request entity too large|request (?:body|size).{0,25}(?:large|limit)|HTTP 413/i.test(reason))return 'images'
 if(/没有返回已确认的结构化交付结果|后台结果正文不能为空|后台产物列表无效|后台产物不在本任务工作目录内/.test(reason))return 'manifest'
 if(/无权|授权|密钥|撤销|unsupported schema|invalid_request|INVALID_REQUEST|HTTP 40[0134]/i.test(reason))return
 if(/ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection closed|network|socket hang up|timed.out|unavailable|HTTP\s+(?:408|429|5\d\d)|(?:^|\s)(?:408|429|5\d\d):|max.tokens|上下文|原生后台任务结束状态：error/i.test(reason))return 'resume'
}

/** The loaded host image-offload projection retains original records and files. */
export function offloadBackgroundImages(session:Session):boolean {
 if(!session.surface?.nodes||typeof session.eventAt!=='function'||typeof session.deriveEventMessage!=='function')return false
 const targets=[]
 for(const seq of session.surface.nodes){
  const event=session.eventAt(seq)
  if(!event||event.type!=='user/message'&&event.type!=='tool/result')continue
  let index=0
  const imageIndexes:number[]=[]
  for(const block of session.deriveEventMessage(event)?.content??[]){
   if(block.type!=='image')continue
   if((block as {offloaded?:boolean}).offloaded!==true)imageIndexes.push(index)
   index++
  }
  if(imageIndexes.length)targets.push({seq,imageIndexes})
 }
 if(!targets.length)return false
 // RC3 registers the native message projection at startup. Older hosts leave the original log intact.
 try{
  const append=session.append.bind(session) as unknown as (type:string,data:unknown)=>void
  append('image/offload',{targets})
  return true
 }catch{return false}
}

function titleTerms(label:string,input:string):Set<string>{
 const head=input.split(/\n\s*\n/u,1)[0]??''
 const text=(label+' '+head).replace(/重来|重做|重新|生成|任务|本次|要求|一张|一版|需要|参考图?|原发起人|用户/gu,' ')
 return new Set(memoryTerms(text).filter(t=>!/^v?\d+$/i.test(t)))
}

/** A rephrased request for the same concrete video download is the same work.
 * Sharing a video alone does not merge analysis, editing or independent tasks.
 */
function sameVideoDownload(label:string,input:string,run:ExecutionRun):boolean {
 const b=run.background!
 const download=(text:string)=>/下载|提取.{0,12}视频|抓取.{0,12}视频/u.test(text)
 if(!download(label)||!download(b.label))return false
 const ids=(text:string)=>[...new Set(text.match(/\bBV[0-9A-Za-z]{10}\b/g)??[])].sort()
 const requested=ids(input),existing=ids(b.input??'')
 return requested.length>0&&requested.length===existing.length&&requested.every((id,index)=>id===existing[index])
}

/** Adopt a correction from the same route only if it matches a unique live objective. */
export function backgroundFollowup(runs:readonly ExecutionRun[],label:string,input:string,events:readonly SessionEvent[],inputId:string):ExecutionRun|undefined{
 const event=events.find(e=>e.type==='user/message'&&e.data.id===inputId)
 const raw=inputOrigin(events,inputId)?.imageRequest??(event?.type==='user/message'?event.data.content.flatMap(p=>p.type==='text'?[p.text]:[]).join('\n'):'')
 if(/(?:另开|另做|另起|另外(?:再|做|开|生成)|新开.{0,6}任务|分别开|独立任务)/u.test(raw))return
 const followup=/(?:继续|补充|重来|重做|改成|改一下|调整|再(?:试|改|调|琢磨|看看)|有点(?:怪|假|僵)|没(?:笑|按)|不太|太(?:假|僵|暗)|上一版|之前的)/u.test(raw)
 const requested=titleTerms(label,input)
 const candidates=runs.filter(run=>{
  if(!['queued','running'].includes(run.status)||!run.background)return false
  const b=run.background
  if(b.input?.trim()===input.trim())return true
  if(sameVideoDownload(label,input,run))return true
  if(!followup)return false
  const words=titleTerms(b.label,b.input??'')
  const matched=[...requested].filter(term=>words.has(term)).length
  return matched>=2||b.label===label
 })
 if(candidates.length>1)throw Error('现有后台任务有多个相符目标，请使用 update 指定原 taskId：'+candidates.map(r=>r.id).join('、'))
 return candidates[0]
}
