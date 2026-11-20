import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Companion} from '../../domain.js'
import {chooseCandidates,cleanSampleText,editedLabels,labelSamples,splitSamples,type SampleMessage,type LabelSample} from './attention-samples.js'
import type {ManagedAttention} from './managed-attention.js'

const day=86400_000
interface Target {scope:string;companion:Companion;boundIds:readonly string[];history:(signal:AbortSignal,from:number)=>Promise<SampleMessage[]>;guard:()=>void}
interface Review {id:string;at:number;source:'history-v2';rows:LabelSample[]}
type BatchStatus={phase:'history'|'labeling'|'training'|'done'|'error'|'cancelled';groups:number;samples?:number;personaSamples?:number;error?:string}
export class GroupAttentionTraining {
 private readonly jobs=new Map<string,{controller:AbortController;done:Promise<void>}>()
 private readonly failures=new Map<string,string>()
 private readonly actions=new Set<string>()
 private readonly batches=new Map<string,BatchStatus>()
 private batch: {channelId:string;controller:AbortController;done:Promise<void>}|undefined
 private closed=false
 constructor(private readonly ctx:Context,private readonly directory:string,private readonly attention:ManagedAttention){}

 private path(scope:string){return join(this.directory,createHash('sha256').update(scope).digest('hex')+'.json')}
 private async review(scope:string){
  try{const stored=JSON.parse(await readFile(this.path(scope),'utf8')) as Review;return stored.source==='history-v2'?stored:undefined}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
 }
 private async save(scope:string,review:Review){
  await mkdir(this.directory,{mode:0o700,recursive:true})
  const target=this.path(scope),tmp=target+'.'+randomUUID()+'.tmp'
  try{await writeFile(tmp,JSON.stringify(review),{mode:0o600,flag:'wx'});await rename(tmp,target)}
  finally{await rm(tmp,{force:true})}
 }
 async view(scope:string){
  const review=await this.review(scope)
  let ready=false
  if(review)try{splitSamples(review.rows);ready=true}catch{}
  return {review,ready,busy:this.jobs.has(scope),error:this.failures.get(scope),model:this.attention.groupStatus(scope)}
 }
 batchView(channelId:string,targets:Target[]){
  const models=targets.map(target=>this.attention.groupStatus(target.scope))
  const versions=models[0]?.versions.filter(version=>(models.length===1||version.id!=='legacy')&&models.every(model=>model.versions.some(item=>item.id===version.id))).map(version=>({
   ...version,current:models.every(model=>model.versions.some(item=>item.id===version.id&&item.current)),
  }))??[]
  return {job:this.batches.get(channelId),busy:this.batch?.channelId===channelId,
   canReset:models.some(model=>model.selected),versions}
 }
 async batchAction(channelId:string,targets:Target[],body:Record<string,unknown>){
  if(this.closed)throw Error('群训练已关闭')
  if(body.action==='cancel'){
   if(this.batch?.channelId===channelId)this.batch.controller.abort()
   return
  }
  if(this.batch||this.jobs.size||this.actions.size)throw Error('已有群历史整理或训练在进行')
  if(!targets.length)throw Error('请选择要训练的群')
  const guard=()=>{for(const target of targets)target.guard()}
  guard()
  const scopes=targets.map(target=>target.scope)
  const scope=scopes[0]!
  if(body.action==='reset'||body.action==='restore-version'){
   if(body.action==='reset'){await this.attention.changeGroup({scope,scopes,guard});return}
   if(typeof body.version!=='string'||!/^(?:legacy|[a-f0-9-]{36})$/.test(body.version)||body.version==='legacy'&&targets.length>1)throw Error('分类头版本无效')
   await this.attention.changeGroup({scope,scopes,guard,version:body.version});return
  }
  if(body.action!=='train'||body.confirm!==true||![1,3,7].includes(Number(body.days)))
   throw Error('请选择历史范围并确认开始训练')
  const controller=new AbortController(),status:BatchStatus={phase:'history',groups:targets.length}
  this.batches.delete(channelId)
  if(this.batches.size>=16)this.batches.delete(this.batches.keys().next().value!)
  this.batches.set(channelId,status)
  const done=this.runBatch(targets,Number(body.days),status,guard,controller.signal).catch(error=>{
   status.phase=controller.signal.aborted?'cancelled':'error'
   if(!controller.signal.aborted)status.error=error instanceof Error?error.message:'训练失败'
  }).finally(()=>{if(this.batch?.controller===controller)this.batch=undefined})
  this.batch={channelId,controller,done}
 }
 private async runBatch(targets:Target[],days:number,status:BatchStatus,guard:()=>void,signal:AbortSignal){
  const histories:SampleMessage[]=[]
  const from=Date.now()-days*day
  const lookup=AbortSignal.any([signal,AbortSignal.timeout(90_000)])
  for(const [index,target] of targets.entries()){
   lookup.throwIfAborted();guard()
   let rows:SampleMessage[]
   try{rows=await target.history(AbortSignal.any([lookup,AbortSignal.timeout(15_000)]),from)}
   catch{signal.throwIfAborted();throw Error('所选群的历史读取失败，请检查 QQ 渠道连接或历史接口')}
   const room=String(index)
   histories.push(...rows.map(row=>({...row,id:room+':'+row.id,room})))
  }
  signal.throwIfAborted();guard()
  const first=targets[0]!
  const candidates=chooseCandidates(histories,from,first.boundIds,first.companion)
  if(candidates.length<36)throw Error('所选群合计的历史样本不足，可以扩大取样时间范围')
  status.phase='labeling';status.samples=candidates.length
  const labeled=await labelSamples(this.ctx,first.companion,candidates,signal,guard)
  signal.throwIfAborted();guard()
  const samples=splitSamples(labeled)
  status.personaSamples=samples.train.intent.filter(row=>row.persona&&row.label==='address').length
  status.phase='training'
  await this.attention.trainGroups(targets.map(target=>target.scope),samples,guard,signal)
  status.phase='done'
 }
 async action(target:Target,body:Record<string,unknown>){
  if(this.closed)throw Error('群训练已关闭')
  if(body.action==='train'&&!this.attention.status().enabled)throw Error('请先开启本地识别')
  const {scope,guard}=target
  guard()
  if(body.action==='cancel'){
   this.jobs.get(scope)?.controller.abort()
   return
  }
  if(this.batch||this.jobs.has(scope)||this.actions.has(scope))throw Error('该群已有样本操作进行中')
  this.actions.add(scope)
  try{await this.apply(target,body)}finally{this.actions.delete(scope)}
 }
 private async apply(target:Target,body:Record<string,unknown>){
  const {scope,guard}=target
  if(body.action==='review'){
   const review=await this.review(scope)
   if(!review||review.id!==body.id)throw Error('样本已变化，请刷新再审核')
   guard()
   await this.save(scope,{...review,id:randomUUID(),rows:editedLabels(review.rows,body.edits)})
   return
  }
  if(body.action==='discard'){
   await rm(this.path(scope),{force:true})
   this.failures.delete(scope)
   return
  }
  if(body.action==='train'){
   const review=await this.review(scope)
   if(!review||review.id!==body.id)throw Error('请先整理并确认本群样本')
   await this.attention.changeGroup({scope,samples:splitSamples(review.rows),guard})
   return
  }
  if(body.action==='reset'){await this.attention.changeGroup({scope,guard});return}
  if(body.action==='restore-version'){
   if(typeof body.version!=='string'||!/^(?:legacy|[a-f0-9-]{36})$/.test(body.version))throw Error('分类头版本无效')
   await this.attention.changeGroup({scope,guard,version:body.version})
   return
  }
  if(body.action!=='label'||body.confirm!==true||![1,3,7].includes(Number(body.days)))throw Error('请选择时间范围并确认模型将读取所选片段')
  if(this.jobs.size>=2)throw Error('已有群样本整理在进行，请稍后再试')
  const controller=new AbortController()
  this.failures.delete(scope)
  const done=this.organize(target,Number(body.days),controller.signal).catch(error=>{
   if(!controller.signal.aborted){
    if(this.failures.size>=24)this.failures.delete(this.failures.keys().next().value!)
    this.failures.set(scope,error instanceof Error?error.message:'群样本整理失败')
   }
  }).finally(()=>this.jobs.delete(scope))
  this.jobs.set(scope,{controller,done})
 }
 private async organize(target:Target,days:number,signal:AbortSignal){
  let history:SampleMessage[]
  const from=Date.now()-days*day
  try{history=await target.history(AbortSignal.any([signal,AbortSignal.timeout(15_000)]),from)}
  catch{signal.throwIfAborted();throw Error('QQ 群历史读取失败，请检查渠道连接或历史接口支持情况')}
  signal.throwIfAborted()
  target.guard()
  const candidates=chooseCandidates(history,from,target.boundIds,target.companion)
  if(candidates.length<36)throw Error('所选时段的群历史样本不足，可以扩大取样时间范围')
  const rows=await labelSamples(this.ctx,target.companion,candidates,signal,target.guard)
  signal.throwIfAborted();target.guard()
  await this.save(target.scope,{id:randomUUID(),at:Date.now(),source:'history-v2',rows})
 }
 async suspend(){
  this.batch?.controller.abort()
  for(const job of this.jobs.values())job.controller.abort()
  await Promise.allSettled([...this.jobs.values()].map(job=>job.done).concat(this.batch?[this.batch.done]:[]))
 }
 async close(){this.closed=true;await this.suspend()}
}

function historyRows(data:unknown,groupId:string){
 const rows=Array.isArray(data)?data:(data as {messages?:unknown}|null)?.messages
 if(!Array.isArray(rows))return []
 return rows.slice(-300).filter(item=>item&&String(item.group_id??groupId)===groupId&&
  (!item.message_type||item.message_type==='group')&&item.message_id!==undefined)
}
function historyTime(value:unknown):number {
 const timestamp=Number(value)
 return timestamp<10_000_000_000?timestamp*1000:timestamp
}
export async function readQqTrainingHistory(fetchPage:(anchor?:number)=>Promise<unknown>,groupId:string,accountId:string,from:number):Promise<SampleMessage[]>{
 const messages=new Map<string,unknown>()
 let anchor:number|undefined
 for(let page=0;page<3;page++){
  const rows=historyRows(await fetchPage(anchor),groupId).filter(row=>{
   const time=historyTime(row.time)
   return Number.isFinite(time)&&time>0
  })
  const fresh=rows.filter(row=>!messages.has(String(row.message_id)))
  for(const row of fresh)messages.set(String(row.message_id),row)
  if(!fresh.length)break
  const oldest=fresh.reduce((a,b)=>historyTime(a.time)<=historyTime(b.time)?a:b)
  if(historyTime(oldest.time)<=from)break
  const next=Number(oldest.message_id)
  if(!Number.isSafeInteger(next)||next===0)break
  anchor=next
 }
 return qqHistorySamples([...messages.values()],groupId,accountId)
}
export function qqHistorySamples(data:unknown,groupId:string,accountId:string):SampleMessage[]{
 const items=historyRows(data,groupId)
 const authors=new Map(items.map(item=>[String(item.message_id),String(item.user_id??item.sender?.user_id??'')]))
 return items.flatMap(item=>{
  const sender=String(item.user_id??item.sender?.user_id??''),at=historyTime(item.time),id=String(item.message_id)
  if(!sender||sender===accountId||!Array.isArray(item.message))return []
  if(!Number.isFinite(at)||at<=0||at>Date.now()+1000)return []
  const parts=item.message.slice(0,40)
  const quoted=parts.find((segment:any)=>segment?.type==='reply')
  const author=quoted?authors.get(String(quoted.data?.id)):undefined
  const recipient=parts.some((segment:any)=>segment?.type==='at'&&String(segment.data?.qq)===accountId)||author&&author===accountId?'partner':author?'member':'unknown'
  const text=cleanSampleText(parts.map((segment:any)=>segment?.type==='text'&&typeof segment.data?.text==='string'?segment.data.text:'').join(''))
  return text?[{id,sender,text,at,recipient}]:[]
 })
}
