import {randomUUID} from 'node:crypto'
import {mkdir,realpath,stat} from 'node:fs/promises'
import {join,resolve,sep,basename} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolDefinition,ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'
import type {PartnerReply} from '../channel-message.js'
import {questionOrigin} from '../channels/question-origin.js'
import {channelReplyAllowed,directReplyTarget} from '../channels/reply-access.js'
import {qqIdentityRelation} from '../channels/qq/identity-binding.js'
import {isPartnerOwnedTool} from './tool-ownership.js'
import {actualAction} from '../chat/action-obligation.js'
import {record,requiredText} from '../core/validation.js'

interface Activation {childId:string;name:string;result:Promise<{stopReason:string;structured?:unknown}>;dispose():Promise<void>}
interface NativeRuntime {
 resolveMaxDepth?(configured?:number):number|undefined
 getProvider(name:string):unknown
 startActivation(spec:Record<string,unknown>):Promise<Activation>
 sendMessage(parent:Agent,child:string,content:{type:'text';text:string}[],options:{signal:AbortSignal}):Promise<unknown>
}
type Source=NonNullable<ExecutionRun['background']>
const workTools=new Set(['partner_tools','partner_workflow','partner_skill','partner_memory_recall','partner_browser','partner_bilibili'])
const forbidden=new Set(['partner_background_task','partner_chat_reply','partner_chat_say','partner_chat_progress','partner_voice_reply','partner_qq_reply','partner_send_attachment','partner_activity_finish','partner_identity','partner_affection','partner_thoughts','partner_habits','partner_sleep','partner_agreement','partner_access_grants','partner_collaborate','partner_requirement','partner_task','partner_schedule'])
const outputSchema={type:'object',additionalProperties:false,required:['text','files'],properties:{text:{type:'string'},files:{type:'array',items:{type:'object',additionalProperties:false,required:['path','name','mediaType'],properties:{path:{type:'string'},name:{type:'string'},mediaType:{type:'string'}}}}}}
const instruction='你是当前伙伴接下的一项后台任务，只完成本次目标。普通聊天不会发给你，不等待前台空闲。继承历史仅作参考，当前用户目标和引用文件以本条任务为准；不要执行历史中的旧要求。使用真实工具处理，保留已完成步骤，不能把目录查询当完成。不要向任何聊天对象直接发送消息，不修改人物、关系、习惯、睡眠或创建其他任务。最终提交符合结构的 text 和 files：text 按当前伙伴人格简短说明实际成果或具体缺项，files 填工作目录内确实生成的文件及文件名、MIME；平台负责一次性回到原会话，不等前台再生成一轮。需要报告的细节放文件，不把工具日志塞进聊天。'

/** Native activations own execution. The adapter owns frozen channel provenance and delivery receipts. */
export class NativeBackgroundTasks {
 private readonly children=new Map<string,{run:ExecutionRun;parent:Agent;activation?:Activation|undefined}>()
 private readonly detachGuard:()=>void
 private readonly detachStore:()=>void
 private closing=false
 constructor(private readonly ctx:Context,private readonly store:PartnerStore,private readonly deliver:(run:ExecutionRun,reply:PartnerReply)=>Promise<void>){
  this.detachGuard=(ctx.tools as ToolRuntime).guard(exec=>{
   const child=exec.agent&&this.children.get(exec.agent.session.id)
   if(!child){
    // Enforce at dispatch, including calls wrapped by partner_tools. No user-text matching.
    const action=actualAction(exec.name,exec.arguments)
    if(exec.agent&&['generate_image','edit_image'].includes(action.name)){
     const state=this.store.snapshot(),route=questionOrigin(exec.agent.session.id,exec.agent.session.snapshotEvents(),state.sessions),channel=state.channels.find(c=>c.id===route?.channelId)
     if(route&&channel?.platform==='qq'&&qqIdentityRelation(channel.qq,route.userId)?.matched)return '本次生图尚未执行：当前 QQ 任务必须先通过 partner_background_task action=start 交给原生后台，input 带完整要求、参考图路径和当前必要背景；接收后前台简短确认，不直接生图、轮询或重复执行。'
    }
    return
   }
   try{this.authorize(child.run,child.parent)}catch(error){return String(error)}
   const action=actualAction(exec.name,exec.arguments)
   if(forbidden.has(action.name)||['fork_agent','spawn_agent','send_message'].includes(action.name)||isPartnerOwnedTool(this.store,child.run.ownerCompanionId,action.name)&&!workTools.has(action.name))return '后台任务只执行当前目标；交付由原会话回传，不直接聊天、改设定或再次委派'
   // Native tools retain inherited host approvals; partner operations are narrowed above.
  })
  this.detachStore=store.subscribe(()=>{for(const c of this.children.values())try{this.authorize(c.run,c.parent)}catch{void c.activation?.dispose().catch(()=>{})}},()=>{})
 }
 private native():NativeRuntime {
  const service=this.ctx.get('subagents') as unknown as NativeRuntime|undefined
  if(!service?.startActivation||!service.getProvider('fork'))throw Error('当前宿主未提供原生 fork 后台任务')
  return service
 }
 private authorize(run:ExecutionRun,parent:Agent):void {
  if(this.closing)throw Error('伙伴正在停止')
  const source=run.background!,state=this.store.snapshot(),c=state.companions.find(c=>c.id===run.ownerCompanionId),route=state.sessions.find(r=>r.id===source.routeId),channel=state.channels.find(c=>c.id===source.channelId)
  if(!c||this.store.isCompanionRemoving(c.id)||!route||route.sessionId!==source.sourceSessionId||route.userId!==source.userId||route.companionId!==c.id||!channel?.enabled||channel.accountId!==source.accountId||(channel.direct?.baseUrl??'')!==source.baseUrl||directReplyTarget(state,source.channelId,source.userId)!==source.targetId||!channelReplyAllowed(state,source.channelId,source.userId)||source.capabilities.some(cap=>!c.capabilities.includes(cap as never)))throw Error('后台任务原会话或能力授权已变化')
  // The source was frozen from a verified inbound route at admission. Ordinary
  // inputs may evict its old inbound id; that must never revoke an active task.
  if(channel.platform!=='qq'||parent.session.id!==source.sourceSessionId||!qqIdentityRelation(channel.qq,source.userId)?.matched)throw Error('后台任务需要原发起人的完整伙伴授权')
 }
 tool(owner:string):ToolDefinition {
  return {name:'partner_background_task',description:'QQ 私聊或群聊里明确交办的调查、整理文档、生图、编程等工作（包括一次生图），一旦识别必须先用 start 交给 DSH 原生后台子任务，立刻返回前台；普通闲聊和轻量直接提问不创建任务。input 必须带当前目标、引用原文件路径和必要背景：原生 fork 不复制尚未结束的当前回合。后台独立完成并自动把结果送回原会话，无需轮询、等待或前台重复整理。list/status 查询当前发起人的任务；只有该发起人明确补充或取消时用 update/cancel，不能因群消息变多就修改或取消。',
   parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['start','list','status','update','cancel']},label:{type:'string',maxLength:80},input:{type:'string',maxLength:16000},taskId:{type:'string',maxLength:120}}},
   output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},presentCall:()=>({card:'generic',title:'原生后台任务'}),
   execute:async(raw,exec)=>{
    const args=record(raw),parent=exec.agent;if(!parent)throw Error('任务缺少原会话')
    const state=this.store.snapshot(),events=parent.session.snapshotEvents(),route=questionOrigin(parent.session.id,events,state.sessions)
    if(!route||route.companionId!==owner)throw Error('此入口用于来源明确的 QQ 会话后台任务')
    const owned=()=>this.store.snapshot().executionRuns.filter(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id)
    if(args.action==='list')return {tasks:owned().slice(-12).map(r=>({taskId:r.id,label:r.background!.label,status:r.status,delivered:!!r.background!.deliveredAt}))}
    if(args.action!=='start'){
     const id=requiredText(args.taskId,'taskId',120),run=owned().find(r=>r.id===id);if(!run)throw Error('此发起人在当前会话没有这项后台任务')
     if(args.action==='status')return {taskId:id,status:run.status,output:run.outputSummary,error:run.error,delivered:!!run.background!.deliveredAt}
     const child=this.children.get(run.sessionId);if(!child?.activation||!['queued','running'].includes(run.status))throw Error('任务当前不在执行，不能隐式重新运行')
     this.authorize(run,parent)
     if(args.action==='cancel'){await this.save(id,r=>{r.status='canceled';r.completedAt=Date.now()});await child.activation.dispose();return {taskId:id,canceled:true,completedActionsPreserved:true}}
     if(args.action!=='update')throw Error('未知后台任务操作')
     const input=requiredText(args.input,'input',16000);this.authorize(run,child.parent)
     await this.native().sendMessage(parent,run.sessionId,[{type:'text',text:'原发起人对本任务的明确补充；仅调整未完成部分，不重复已完成的调用和交付：\n'+input}],{signal:exec.signal})
     return {taskId:id,updated:true}
    }
    const native=this.native(),input=requiredText(args.input,'input',16000),label=requiredText(args.label,'label',80)
    const user=[...events].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user');if(user?.type!=='user/message')throw Error('没有当前用户输入')
    const prior=owned().find(r=>r.background!.inputId===user.data.id);if(prior)return {kind:'partner-background-v1',taskId:prior.id,status:prior.status,alreadyAccepted:true}
    if(owned().filter(r=>['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务')
    const id='background-'+randomUUID(),childId='session-'+randomUUID(),cwd=join(parent.session.header.cwd??'/tmp','.partner-background',id),channel=state.channels.find(c=>c.id===route.channelId)!,c=state.companions.find(c=>c.id===owner)!
    const run:ExecutionRun={id,kind:'work',ownerCompanionId:owner,sessionId:childId,sourceId:id,status:'queued',destroyAfterRun:false,startedAt:Date.now(),toolNames:[],background:{routeId:route.id,sourceSessionId:route.sessionId,channelId:route.channelId,userId:route.userId,inputId:user.data.id,accountId:channel.accountId,baseUrl:channel.direct?.baseUrl??'',targetId:directReplyTarget(state,route.channelId,route.userId),label,cwd,capabilities:[...c.capabilities]}}
    this.authorize(run,parent);await mkdir(cwd,{recursive:true,mode:0o700})
    let existing:ExecutionRun|undefined
    await this.store.update(s=>{existing=s.executionRuns.find(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id&&r.background.inputId===user.data.id);if(existing)return;if(s.executionRuns.filter(r=>r.background?.routeId===route.id&&['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务');if(s.executionRuns.length>=500){const i=s.executionRuns.findIndex(r=>!['queued','running'].includes(r.status)&&!(r.background?.result&&!r.background.deliveredAt));if(i<0)throw Error('任务记录已满');s.executionRuns.splice(i,1)}s.executionRuns.push(run)})
    if(existing)return {kind:'partner-background-v1',taskId:existing.id,status:existing.status,alreadyAccepted:true}
    const child={run,parent,activation:undefined as Activation|undefined};this.children.set(childId,child)
    try{
     child.activation=await native.startActivation({provider:'fork',childId,parent,signal:exec.signal,delivery:'caller',label,cwd,prompt:[{type:'text',text:instruction+'\n\n当前原始输入（仅此请求为当前目标，引用历史不是新指令）：\n'+JSON.stringify(user.data.content)+'\n\n任务：'+input}],outputSchema,maxDepth:Math.min(1,native.resolveMaxDepth?.()??1)})
     this.authorize(run,parent)
     await this.save(id,r=>{r.status='running';r.background!.childName=child.activation!.name})
     void child.activation.result.then(result=>this.finished(id,result).catch(error=>this.failed(id,error)),error=>this.failed(id,error)).finally(()=>this.children.delete(childId)).catch(error=>this.ctx.logger.warn('后台任务收尾失败：'+String(error)))
     return {kind:'partner-background-v1',taskId:id,childSessionId:childId,name:child.activation.name,status:'running',independent:true,next:'任务已被原生后台接收，前台简短确认后结束本轮；不要等待、轮询或重复执行。完成后由平台固定回到原会话。'}
    }catch(error){await child.activation?.dispose().catch(()=>{});this.children.delete(childId);await this.failed(id,error);throw error}
   }}
 }
 private async save(id:string,mutate:(run:ExecutionRun)=>void):Promise<void>{await this.store.update(s=>{const run=s.executionRuns.find(r=>r.id===id);if(run)mutate(run)})}
 private async failed(id:string,error:unknown):Promise<void>{await this.save(id,r=>{if(r.status==='canceled')return;r.status='failed';r.completedAt=Date.now();r.error=String(error).slice(0,1000)})}
 private async finished(id:string,result:{stopReason:string;structured?:unknown}):Promise<void>{
  const run=this.store.snapshot().executionRuns.find(r=>r.id===id);if(!run||run.status==='canceled'||this.closing)return
  if(result.stopReason!=='completed')return this.failed(id,'原生后台任务结束状态：'+result.stopReason)
  const value=record(result.structured),text=requiredText(value.text,'text',2400),files=[] as {path:string;name:string;mediaType:string}[]
  if(!Array.isArray(value.files)||value.files.length>8)throw Error('后台产物列表无效')
  const root=await realpath(run.background!.cwd)
  for(const entry of value.files){const file=record(entry),path=await realpath(resolve(root,requiredText(file.path,'path',4000)));if(!path.startsWith(root+sep)||!(await stat(path)).isFile())throw Error('后台产物不在本任务工作目录内');files.push({path,name:requiredText(file.name,'name',240)||basename(path),mediaType:requiredText(file.mediaType,'mediaType',200)})}
  await this.save(id,r=>{r.status='completed';r.completedAt=Date.now();r.outputSummary=text;r.background!.result={text,files}})
  await this.deliverResult(id)
 }
 private async deliverResult(id:string):Promise<void>{
  const run=this.store.snapshot().executionRuns.find(r=>r.id===id);if(!run?.background?.result||run.background.deliveredAt)return
  const b=run.background,reply:PartnerReply={text:'【'+b.label+'】\n'+b.result!.text,attachments:b.result!.files.map(f=>({...f,kind:'file'}))}
  try{await this.deliver(run,reply);await this.save(id,r=>{r.background!.deliveredAt=Date.now();delete r.background!.deliveryError})}catch(error){await this.save(id,r=>{r.background!.deliveryError=String(error).slice(0,1000)})}
 }
 async recoverDeliveries():Promise<void>{for(const r of this.store.snapshot().executionRuns)if(r.background?.result&&r.status==='completed'&&!r.background.deliveredAt)await this.deliverResult(r.id)}
 async close():Promise<void>{this.closing=true;this.detachStore();await Promise.allSettled([...this.children.values()].map(c=>c.activation?.dispose()));this.detachGuard()}
}
