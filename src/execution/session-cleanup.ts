import {runtimePolicy} from '../companions/runtime-policy.js'
import {cleanupWorkCatalog} from './catalog-cleanup.js'
import {lstat,realpath,rm} from 'node:fs/promises'
import {basename,dirname,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'

type Persistence={stat(id:string):Promise<{header:{id:string;cwd?:string;parentSession?:string};location?:{kind:string;path:string}}|undefined>;open(id:string,access:'write'):Promise<{close():Promise<void>}>}
const terminal=(run:ExecutionRun)=>!['queued','running'].includes(run.status)
/** Delete only a proven partner work log after its result has left the child. Artifacts stay. */
export async function cleanupWorkSession(ctx:Context,store:PartnerStore,run:ExecutionRun):Promise<boolean>{
 const state=store.snapshot(),current=state.executionRuns.find(r=>r.id===run.id&&r.sessionId===run.sessionId&&r.ownerCompanionId===run.ownerCompanionId)
 if(current?.background?.review&&!current.background.review.doneAt)return false
 if(current?.status==='canceled'&&current.background&&!current.background.stoppedAt&&!current.background.review?.doneAt&&!current.background.discardedAt)return false
 if(!current||!terminal(current)||current.sessionCleanup?.deletedAt||state.sessions.some(r=>r.sessionId===run.sessionId))return false
 if(current.background&&!current.background.deliveredAt&&(current.background.result||!current.background.review&&current.error?.includes('后台产物不在本任务工作目录内')))return false
 if(!current.background&&!current.sessionCleanup?.parentSessionId&&!run.sessionId.startsWith('partner-run-'))return false
 const agents=ctx.get('agents') as {get?:(id:string)=>unknown}|undefined
 if(agents?.get?.(run.sessionId))return false
 const persistence=ctx.get('sessionPersistence') as Persistence|undefined
 if(!persistence?.stat||!persistence.open)return false
 const snapshot=await persistence.stat(run.sessionId)
 if(!snapshot){await markDeleted(store,run.id);return true}
 if(snapshot.header.id!==run.sessionId)throw Error('工作会话存储身份不匹配')
 const parent=current.background?.sourceSessionId??current.sessionCleanup?.parentSessionId
 if(parent&&snapshot.header.parentSession!==parent)throw Error('工作会话父会话不匹配')
 const location=snapshot.location
 if(location?.kind!=='jsonl'||basename(dirname(location.path))!==run.sessionId)throw Error('此存储后端不支持已核验的工作会话清理')
 const directory=dirname(location.path),entry=await lstat(directory)
 if(entry.isSymbolicLink()||!entry.isDirectory()||await realpath(directory)!==resolve(directory))throw Error('拒绝清理链接或异常会话目录')
 // Acquiring and closing a write lease verifies that no writer still owns this log.
 const handle=await persistence.open(run.sessionId,'write');await handle.close()
 const live=store.snapshot().executionRuns.find(r=>r.id===run.id)
 if(!live||live.background?.review&&!live.background.review.doneAt||!terminal(live)||live.status==='canceled'&&live.background&&!live.background.stoppedAt&&!live.background.review?.doneAt&&!live.background.discardedAt||live.background?.result&&!live.background.deliveredAt||store.snapshot().sessions.some(r=>r.sessionId===run.sessionId)||agents?.get?.(run.sessionId))return false
 await rm(directory,{recursive:true,force:true})
 await markDeleted(store,run.id)
 return true
}
async function markDeleted(store:PartnerStore,id:string):Promise<void>{await store.update(s=>{const r=s.executionRuns.find(r=>r.id===id);if(r)r.sessionCleanup={...r.sessionCleanup,deletedAt:Date.now()}})}

/** Track native descendants only when their creation ancestry belongs to a partner. */
export class PartnerWorkSessionCleanup {
 private running=false
 private readonly dispose:Array<()=>void>=[]
 constructor(private ctx:Context,private store:PartnerStore){
  const listen=ctx.on.bind(ctx) as unknown as (event:string,fn:(info:any)=>Promise<void>)=>()=>void
  this.dispose.push(listen('subagent/start',async info=>{
   if(!info.local)return
   const state=store.snapshot();if(state.executionRuns.some(r=>r.sessionId===info.id)||state.sessions.some(r=>r.sessionId===info.id))return
   const owner=state.sessions.find(r=>r.sessionId===info.parentSessionId)?.companionId??state.executionRuns.find(r=>r.sessionId===info.parentSessionId)?.ownerCompanionId
   if(!owner||!runtimePolicy(store,owner)?.rules.autoChildCleanup)return
   await store.update(s=>{if(!s.executionRuns.some(r=>r.sessionId===info.id))s.executionRuns.push({id:'native-child-'+info.id,kind:'work',sourceId:info.parentSessionId,sessionId:info.id,ownerCompanionId:owner,status:'running',destroyAfterRun:true,startedAt:Date.now(),toolNames:[],sessionCleanup:{parentSessionId:info.parentSessionId}})})
  }))
  this.dispose.push(listen('subagent/end',async info=>{
   if(!store.snapshot().executionRuns.some(r=>r.id==='native-child-'+info.id))return
   await store.update(s=>{const r=s.executionRuns.find(r=>r.id==='native-child-'+info.id);if(!r)return;r.status=info.stopReason==='completed'?'completed':['aborted','canceled','interrupted'].includes(info.stopReason)?'canceled':'failed';r.completedAt=Date.now();r.outputSummary=(info.lastAssistantMessage??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');if(info.stopReason!=='completed')r.error='原生子任务结束：'+info.stopReason})
  }))
 }
 async sweep():Promise<void>{
  if(this.running)return;this.running=true
  try{for(const run of this.store.snapshot().executionRuns){if(!runtimePolicy(this.store,run.ownerCompanionId)?.rules.autoChildCleanup||!terminal(run)||!run.background&&!run.sessionCleanup?.parentSessionId&&!run.sessionId.startsWith('partner-run-'))continue;try{if(!run.sessionCleanup?.deletedAt)await cleanupWorkSession(this.ctx,this.store,run);await cleanupWorkCatalog(this.ctx,this.store,run)}catch(error){this.ctx.logger.warn('伙伴工作会话清理暂未完成：'+String(error))}}}finally{this.running=false}
 }
 close():void{for(const dispose of this.dispose.reverse())dispose()}
}
