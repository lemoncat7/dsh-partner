import {basename,dirname,extname,join,resolve,sep} from 'node:path'
import {copyFile,mkdtemp,realpath,stat} from 'node:fs/promises'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ExecutionRun} from './domain.js'

export interface ReviewFile {sourcePath?:string;path:string;name:string;mediaType:string}
export interface BackgroundReview {
 kind?:'completion'
 resultText?:string
 allowQuiet?:boolean
 reason:string
 lastStatement?:string
 tools:string[]
 files:ReviewFile[]
 canResume:boolean
 decision?:{action:'deliver'|'continue'|'hold'|'wait';text:string;files:number[]}
 doneAt?:number
 retryAt?:number
}
export function diagnostic(value:unknown):string{
 const message=value instanceof Error?value.message:String(value)
 return message.replace(/Bearer\s+[^\s"']+|(?:sk-|sk_)[\w-]{10,}/gi,'[redacted]').replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/g,'$1').slice(0,900)
}
/** Use only successful image tool outputs from this child, never reference images or neighbouring jobs. */
export async function reviewEvidence(run:ExecutionRun,events:readonly SessionEvent[],reason:string,structured?:unknown):Promise<BackgroundReview>{
 const b=run.background!,calls=new Map<string,string>(),tools:string[]=[],paths=new Set<string>()
 let lastStatement:string|undefined
 let end:Extract<SessionEvent,{type:'turn/end'}>|undefined
 for(const e of events){
  if(e.type==='turn/end')end=e
  if(e.type==='assistant/message'&&!e.data.interrupted){
   const statement=e.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join(' ').trim()
   if(statement)lastStatement=diagnostic(statement)
  }
  if(e.type==='tool/call')calls.set(e.data.callId,e.data.name)
  const result=e.type==='tool/result'?e.data.message:e.type==='tool/ptc-dispatch'?e.data:undefined
  const name=e.type==='tool/ptc-dispatch'?e.data.name:e.type==='tool/result'?calls.get(e.data.message.toolCallId):undefined
  if(!result||!name)continue
  tools.push(name+(result.isError?' (失败)':' (完成)'))
  if(name!=='generate_image'||result.isError)continue
  for(const block of result.content??[])if(block.type==='text'){
   try{const payload=JSON.parse(block.text);if(Array.isArray(payload.files))for(const f of payload.files)if(typeof f?.path==='string')paths.add(f.path)}catch{/* Non-JSON responses carry no file provenance. */}
  }
 }
 if(end?.data.reason.kind==='error')reason+='；'+diagnostic(end.data.reason.error.code)+' '+diagnostic(end.data.reason.error.message)
 else if(end?.data.reason.kind==='completed'&&structured===undefined&&reason.startsWith('原生后台任务结束状态：error'))reason+='；子会话已正常结束，但宿主没有返回已确认的结构化交付结果'
 const files:ReviewFile[]=[]
 const root=await realpath(b.cwd).catch(()=>undefined)
 const source=b.sourceCwd&&await realpath(b.sourceCwd).catch(()=>undefined)
 const candidates=new Map<string,{name:string;mediaType:string}>()
 // The host supplies this object only after its structured tool has committed.
 // Without a commit, only successful image receipts identify files for delivery.
 const manifest=structured as {text?:unknown;files?:unknown}|undefined
 if(typeof manifest?.text==='string')lastStatement=diagnostic(manifest.text)
 if(root&&Array.isArray(manifest?.files)){
  for(const file of manifest.files.slice(0,48)){
   if(typeof file?.path!=='string'||typeof file.name!=='string'||typeof file.mediaType!=='string')continue
   const path=await realpath(resolve(root,file.path)).catch(()=>undefined)
   if(path?.startsWith(root+sep))candidates.set(path,{name:basename(file.name),mediaType:file.mediaType})
  }
 }
 if(root)for(const raw of [...paths].slice(-48)){
  const path=await realpath(resolve(root,raw)).catch(()=>undefined)
  if(!path||!(path.startsWith(root+sep)||source&&dirname(path)===join(source,'generated')))continue
  const mediaType=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(path).toLowerCase()]
  if(mediaType)candidates.set(path,{name:basename(path),mediaType})
 }
 const staged=new Map<string,ReviewFile>()
 if(root)for(const file of b.review?.files??[]){
  const path=await realpath(file.path).catch(()=>undefined)
  if(path?.startsWith(root+sep+'.review-files-')&&(await stat(path).catch(()=>undefined))?.isFile()){
    staged.set(file.sourcePath??file.path,file)
    files.push(file)
  }
 }
 let directory:string|undefined
 if(root)for(const [sourcePath,info] of candidates){
  if(staged.has(sourcePath))continue
  if(!(await stat(sourcePath).catch(()=>undefined))?.isFile())continue
  directory??=await mkdtemp(join(root,'.review-files-'))
  const dest=join(directory,String(files.length)+extname(sourcePath))
  try{await copyFile(sourcePath,dest,1)}catch(error){reason+='；保存候选文件失败：'+diagnostic(error);continue}
  files.push({sourcePath,path:dest,...info})
 }
 return {reason,...(lastStatement?{lastStatement}:{}),tools:tools.slice(-24),files,canResume:events.length>0&&!b.reviewResumed&&!run.sessionCleanup?.deletedAt}
}
export function reviewDecision(text:string,review:BackgroundReview):NonNullable<BackgroundReview['decision']>{
 const v=JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''))
 if(!v||!['hold','deliver','continue','wait'].includes(v.action)||typeof v.text!=='string'||!v.text.trim()||!Array.isArray(v.files)||v.files.length>8||
   v.files.some((n:unknown)=>typeof n!=='number'||!Number.isInteger(n)||!review.files[n])||v.action==='continue'&&!review.canResume||v.action!=='deliver'&&v.files.length||v.action==='hold'&&review.kind==='completion'&&!review.allowQuiet)throw Error('前台任务处置格式无效')
 return {action:v.action,text:v.text.trim(),files:[...new Set<number>(v.files)]}
}
