import type {Context} from '@deepseek-ai/cordis'
import {appendPluginRecord,pluginRecordOf,Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'

type CleanupRecord={version:1;childId:string;runId:string;ownerCompanionId:string}
const RECORD='plugin:dsh-partner/subagent-cleaned'
declare module '@deepseek-ai/dsh-session/types' {interface PluginRecordMap {'plugin:dsh-partner/subagent-cleaned':CleanupRecord}}
type Handle={header:{id:string};read():Promise<{events:SessionEvent[]}>;append(events:SessionEvent[]):Promise<void>;flush():Promise<void>;close():Promise<void>}
type Persistence={open(id:string,access:'write'):Promise<Handle>;flush?():Promise<void>}
/** Retire discovery only after a proven work log was removed; never rewrite parent history. */
export async function cleanupWorkCatalog(ctx:Context,store:PartnerStore,run:ExecutionRun):Promise<boolean>{
 const state=store.snapshot(),current=state.executionRuns.find(r=>r.id===run.id&&r.sessionId===run.sessionId&&r.ownerCompanionId===run.ownerCompanionId)
 if(!current?.sessionCleanup?.deletedAt||current.sessionCleanup.catalogRemovedAt||['running','queued'].includes(current.status)||current.background?.result&&!current.background.deliveredAt)return false
 const parent=current.background?.sourceSessionId??current.sessionCleanup.parentSessionId
 if(!parent||parent===current.sessionId)return false
 if(!state.sessions.some(r=>r.sessionId===parent&&r.companionId===current.ownerCompanionId)&&!state.executionRuns.some(r=>r.sessionId===parent&&r.ownerCompanionId===current.ownerCompanionId)&&!state.sessions.some(r=>r.id===current.background?.routeId&&r.companionId===current.ownerCompanionId))return false
 const persistence=ctx.get('sessionPersistence') as Persistence|undefined
 const subagents=ctx.get('subagents') as {listDescendants?(id:string):Promise<{id:string}[]>}|undefined
 if(!persistence||!subagents?.listDescendants)return false
 const data:CleanupRecord={version:1,childId:current.sessionId,runId:current.id,ownerCompanionId:current.ownerCompanionId}
 const needsRecord=(events:readonly SessionEvent[])=>{
  const catalog=events.some(e=>{const row=e as unknown as {type:string;data?:{childId?:string}};return row.type==='subagent/catalog'&&row.data?.childId===current.sessionId})
  return catalog&&!events.some(e=>{const r=pluginRecordOf(e);return r?.type===RECORD&&(r.data as CleanupRecord).childId===current.sessionId})
 }
 const sessions=ctx.get('sessions') as {get(id:string):Session|undefined}|undefined,live=sessions?.get(parent)
 if(live){
  if(needsRecord(live.snapshotEvents())){appendPluginRecord(live,RECORD,data);await persistence.flush?.()}
 }else{
  const handle=await persistence.open(parent,'write')
  try{
   if(handle.header.id!==parent)throw Error('目录清理父会话身份不匹配')
   const {events}=await handle.read()
   if(needsRecord(events)){
    // Build a validated ignorable record, then append at the leased log's next sequence.
    const temporary=Session.create(parent as Session['id']);appendPluginRecord(temporary,RECORD,data)
    const record={...temporary.snapshotEvents()[0]!,seq:(events.at(-1)?.seq??-1)+1} as SessionEvent
    await handle.append([record]);await handle.flush()
   }
  }finally{await handle.close()}
 }
 // Verify the exact discovery surface used by the UI; unsupported hosts retry visibly.
 if((await subagents.listDescendants(parent)).some(r=>r.id===current.sessionId))throw Error('宿主仍保留已回收工作会话的子智能体目录，需要目录清理支持')
 await store.update(s=>{const r=s.executionRuns.find(r=>r.id===current.id);if(r?.sessionCleanup?.deletedAt)r.sessionCleanup.catalogRemovedAt=Date.now()})
 return true
}
