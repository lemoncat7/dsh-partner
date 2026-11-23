import {runtimePolicy,runtimeSnapshot} from '../companions/runtime-policy.js'
import {lstat,realpath,rm} from 'node:fs/promises'
import {basename,dirname,resolve} from 'node:path'
import {appendPluginRecord,pluginRecordOf,Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {Context} from '@deepseek-ai/cordis'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'

type Persistence={stat(id:string):Promise<{header:{id:string;cwd?:string;parentSession?:string};location?:{kind:string;path:string}}|undefined>;open(id:string,access:'write'):Promise<{close():Promise<void>}>}
const terminal=(run:ExecutionRun)=>!['queued','running'].includes(run.status)
const parentOf=(run:ExecutionRun)=>run.background?.sourceSessionId??run.sessionCleanup?.parentSessionId
const cleaned='plugin:dsh-partner/subagent-cleaned'
type CleanupRecord={version:1;childId:string;runId:string;ownerCompanionId:string}
declare module '@deepseek-ai/dsh-session/types' {
 interface PluginRecordMap {'plugin:dsh-partner/subagent-cleaned':CleanupRecord}
}

type CatalogState={inheritedEventCount?:number;partnerRetired?:string[]}
type CatalogProjection={key:string;stateVersion:number;stateSchema:{parse(value:unknown):CatalogState};apply(state:CatalogState,event:SessionEvent):CatalogState;wire?:{view(state:CatalogState):readonly {id:string}[]}}

/** Older hosts publish creation-only catalogs. Filter the wire view, retaining native names and history. */
function installCatalogView(ctx:Context,store:PartnerStore):()=>void {
 const registry=ctx.get?.('sessionProjections' as never) as {registrations?:Map<string,{def:CatalogProjection}>}|undefined
 const projection=registry?.registrations?.get('subagentCatalog')?.def
 const wire=projection?.wire
 if(!projection||!wire||projection.key!=='subagentCatalog'||![6,7].includes(projection.stateVersion)||typeof wire.view!=='function'||typeof projection.apply!=='function'||typeof projection.stateSchema?.parse!=='function')return ()=>{}
 const view=wire.view, apply=projection.apply, schema=projection.stateSchema, version=projection.stateVersion
 const retired=(run:ExecutionRun)=>!!(parentOf(run)&&run.sessionCleanup?.deletedAt&&terminal(run))
 const visible:typeof view=state=>{
  const entries=view(state)
  if(!entries.length)return entries
  const ids=new Set(state.partnerRetired)
  for(const run of runtimeSnapshot(store).executionRuns)if(retired(run))ids.add(run.sessionId)
  return entries.filter(entry=>!ids.has(entry.id))
 }
 const refresh:typeof apply=(state,event)=>{
  const next=apply(state,event)
  if(next!==state||event.seq<(state.inheritedEventCount??0))return next
  const record=pluginRecordOf(event)
  if(record?.type!==cleaned)return next
  const data=record.data as Partial<CleanupRecord>|undefined
  if(data?.version!==1||typeof data.childId!=='string'||typeof data.runId!=='string'||typeof data.ownerCompanionId!=='string'||next.partnerRetired?.includes(data.childId))return next
  const run=runtimeSnapshot(store).executionRuns.find(run=>run.sessionId===data.childId)
  if(run&&(!retired(run)||run.id!==data.runId||run.ownerCompanionId!==data.ownerCompanionId))return next
  return {...next,partnerRetired:[...(next.partnerRetired??[]),data.childId]}
 }
 const parse:typeof schema.parse=value=>{
  const state=schema.parse(value), ids=(value as CatalogState|undefined)?.partnerRetired
  return Array.isArray(ids)&&ids.every(id=>typeof id==='string')?{...state,partnerRetired:ids}:state
 }
 const extended={parse}
 wire.view=visible;projection.apply=refresh;projection.stateSchema=extended;projection.stateVersion=8
 return ()=>{if(wire.view===visible)wire.view=view;if(projection.apply===refresh)projection.apply=apply;if(projection.stateSchema===extended){projection.stateSchema=schema;projection.stateVersion=version}}
}
const canRetireCanceled=(run:ExecutionRun)=>{
 const b=run.background
 return !b||run.status!=='canceled'||!!(b.stoppedAt||b.discardedAt||b.deliveredAt||b.review?.doneAt&&!b.interruptedAt)
}
/** Delete only a proven partner work log after its result has left the child. Artifacts stay. */
export async function cleanupWorkSession(ctx:Context,store:PartnerStore,run:ExecutionRun):Promise<boolean>{
 const state=store.snapshot(),current=state.executionRuns.find(r=>r.id===run.id&&r.sessionId===run.sessionId&&r.ownerCompanionId===run.ownerCompanionId)
 if(current?.background?.review&&!current.background.review.doneAt)return false
 if(!current||!terminal(current)||!canRetireCanceled(current)||current.sessionCleanup?.deletedAt||state.sessions.some(r=>r.sessionId===run.sessionId))return false
 if(current.background&&!current.background.deliveredAt&&(current.background.result||!current.background.review&&current.error?.includes('后台产物不在本任务工作目录内')))return false
 if(!current.background&&!current.sessionCleanup?.parentSessionId&&!run.sessionId.startsWith('partner-run-'))return false
 const agents=ctx.get('agents') as {get?:(id:string)=>{session?:Session}|undefined}|undefined
 if(agents?.get?.(run.sessionId))return false
 const persistence=ctx.get('sessionPersistence') as Persistence|undefined
 if(!persistence?.stat||!persistence.open)return false
 const snapshot=await persistence.stat(run.sessionId)
 const parent=parentOf(current)
 const mark=async()=>{
  await markDeleted(store,run.id)
  const session=parent?agents?.get?.(parent)?.session:undefined
  if(session instanceof Session)appendPluginRecord(session,cleaned,{version:1,childId:run.sessionId,runId:run.id,ownerCompanionId:run.ownerCompanionId})
 }
 if(!snapshot){await mark();return true}
 if(snapshot.header.id!==run.sessionId)throw Error('工作会话存储身份不匹配')
 if(parent&&snapshot.header.parentSession!==parent)throw Error('工作会话父会话不匹配')
 const location=snapshot.location
 if(location?.kind!=='jsonl'||basename(dirname(location.path))!==run.sessionId)throw Error('此存储后端不支持已核验的工作会话清理')
 const directory=dirname(location.path),entry=await lstat(directory)
 if(entry.isSymbolicLink()||!entry.isDirectory()||await realpath(directory)!==resolve(directory))throw Error('拒绝清理链接或异常会话目录')
 // Acquiring and closing a write lease verifies that no writer still owns this log.
 const handle=await persistence.open(run.sessionId,'write');await handle.close()
 const live=store.snapshot().executionRuns.find(r=>r.id===run.id)
 if(!live||live.background?.review&&!live.background.review.doneAt||!terminal(live)||!canRetireCanceled(live)||live.background?.result&&!live.background.deliveredAt||store.snapshot().sessions.some(r=>r.sessionId===run.sessionId)||agents?.get?.(run.sessionId))return false
 await rm(directory,{recursive:true,force:true})
 await mark()
 return true
}
async function markDeleted(store:PartnerStore,id:string):Promise<void>{
 await store.update(s=>{
  const run=s.executionRuns.find(r=>r.id===id)
  if(!run)return
  run.sessionCleanup={...run.sessionCleanup,deletedAt:Date.now()}
  if(run.background)delete run.background.imageReferences
 })
}

/** Track native descendants only when their creation ancestry belongs to a partner. */
export class PartnerWorkSessionCleanup {
 private readonly pending=new Set<string|undefined>()
 private sweeping?:Promise<void>|undefined
 private closed=false
 private readonly dispose:Array<()=>void>=[]
 constructor(private ctx:Context,private store:PartnerStore){
  this.dispose.push(installCatalogView(ctx,store))
  const listen=ctx.on.bind(ctx) as unknown as (event:string,fn:(info:any)=>Promise<void>)=>()=>void
  this.dispose.push(listen('subagent/start',async info=>{
   if(!info.local)return
   const state=store.snapshot();if(state.executionRuns.some(r=>r.sessionId===info.id)||state.sessions.some(r=>r.sessionId===info.id))return
   const owner=state.sessions.find(r=>r.sessionId===info.parentSessionId)?.companionId??state.executionRuns.find(r=>r.sessionId===info.parentSessionId)?.ownerCompanionId
   if(!owner||!runtimePolicy(store,owner)?.rules.autoChildCleanup)return
   await store.update(s=>{if(!s.executionRuns.some(r=>r.sessionId===info.id))s.executionRuns.push({id:'native-child-'+info.id,kind:'work',sourceId:info.parentSessionId,sessionId:info.id,ownerCompanionId:owner,status:'running',destroyAfterRun:true,startedAt:Date.now(),toolNames:[],sessionCleanup:{parentSessionId:info.parentSessionId}})})
  }))
  this.dispose.push(listen('subagent/end',async info=>{
   const run=store.snapshot().executionRuns.find(r=>r.id==='native-child-'+info.id)
   if(!run)return
   await store.update(s=>{const r=s.executionRuns.find(r=>r.id==='native-child-'+info.id);if(!r)return;r.status=info.stopReason==='completed'?'completed':['aborted','canceled','interrupted'].includes(info.stopReason)?'canceled':'failed';r.completedAt=Date.now();r.outputSummary=(info.lastAssistantMessage??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');if(info.stopReason!=='completed')r.error='原生子任务结束：'+info.stopReason})
   this.schedule(parentOf(run))
  }))
  this.dispose.push(listen('agent/disposed',async ({agent})=>{
   const run=store.snapshot().executionRuns.find(r=>r.sessionId===agent.session.id&&terminal(r)&&!r.sessionCleanup?.deletedAt)
   if(run&&parentOf(run))this.schedule(parentOf(run))
  }))
 }
 schedule(parent:string|undefined):void{
  void this.sweep(parent).catch(error=>this.ctx.logger.warn('伙伴工作会话清理失败：'+String(error)))
 }
 sweep(parent?:string):Promise<void>{
  if(this.closed)return Promise.resolve()
  this.pending.add(parent)
  return this.sweeping??=Promise.resolve().then(()=>this.drain())
 }
 private async drain():Promise<void>{
  try{
   while(this.pending.size&&!this.closed){
    const parents=new Set(this.pending)
    this.pending.clear()
    await this.sweepRuns(parents)
   }
  }finally{this.sweeping=undefined}
 }
 private async sweepRuns(parents:ReadonlySet<string|undefined>):Promise<void>{
   const matches=(run:ExecutionRun)=>parents.has(undefined)||parents.has(parentOf(run))
   const runs=this.store.snapshot().executionRuns.filter(matches)
   if(runs.some(run=>run.sessionCleanup?.deletedAt&&run.background?.imageReferences))await this.store.update(s=>{
    for(const run of s.executionRuns)if(matches(run)&&run.sessionCleanup?.deletedAt&&run.background)delete run.background.imageReferences
   })
   for(const run of runs){
    const explicitlyClosed=run.background?.stoppedAt||run.background?.discardedAt
    if(!terminal(run)||!explicitlyClosed&&!runtimePolicy(this.store,run.ownerCompanionId)?.rules.autoChildCleanup||!run.background&&!run.sessionCleanup?.parentSessionId&&!run.sessionId.startsWith('partner-run-'))continue
    try{if(!run.sessionCleanup?.deletedAt)await cleanupWorkSession(this.ctx,this.store,run)}catch(error){this.ctx.logger.warn('伙伴工作会话清理暂未完成：'+String(error))}
   }
 }
 close():void{this.closed=true;this.pending.clear();for(const dispose of this.dispose.reverse())dispose()}
}
