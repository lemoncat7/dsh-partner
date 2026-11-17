import {runtimeSnapshot,runtimePolicy,runtimeSessionPolicy} from '../companions/runtime-policy.js'
import {randomUUID} from 'node:crypto'
import {mkdir,realpath,stat,copyFile} from 'node:fs/promises'
import {join,resolve,sep,basename,dirname} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolDefinition,ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'
import type {PartnerReply} from '../channel-message.js'
import {backgroundOrigin,backgroundRequired,backgroundWork} from './background-routing.js'
import {bindBackgroundScope} from './background-scope.js'
import {browserAudience} from '../browser/context.js'
import {isPartnerMcpOperation} from '../mcp/tool-entry.js'
import {nativePresentation} from '../compat/native-presentation.js'
import {channelReplyAllowed,directReplyTarget} from '../channels/reply-access.js'
import {qqIdentityRelation} from '../channels/qq/identity-binding.js'
import {isPartnerOwnedTool} from './tool-ownership.js'
import {actualAction} from '../chat/action-obligation.js'
import {hasTaskPreamble} from './task-preamble.js'
import {record,requiredText} from '../core/validation.js'

interface Activation {childId:string;name:string;result:Promise<{stopReason:string;structured?:unknown}>;dispose():Promise<void>}
interface NativeRuntime {
 resolveMaxDepth?(configured?:number):number|undefined
 getProvider(name:string):unknown
 registerProvider(provider:Record<string,unknown>):()=>void
 startActivation(spec:Record<string,unknown>):Promise<Activation>
 resumeActivation?(spec:Record<string,unknown>):Promise<Activation>
 sendMessage(parent:Agent,child:string,content:{type:'text';text:string}[],options:{signal:AbortSignal}):Promise<unknown>
}
const workTools=new Set(['partner_workflow','partner_skill','partner_browser','partner_mcp','partner_bilibili'])
const forbidden=new Set(['partner_background_task','partner_chat_reply','partner_chat_say','partner_chat_progress','partner_voice_reply','partner_qq_reply','partner_send_attachment','partner_activity_finish','partner_identity','partner_affection','partner_thoughts','partner_habits','partner_sleep','partner_agreement','partner_access_grants','partner_collaborate','partner_requirement','partner_task','partner_schedule'])
const outputSchema={type:'object',additionalProperties:false,required:['text','files'],properties:{text:{type:'string'},files:{type:'array',items:{type:'object',additionalProperties:false,required:['path','name','mediaType'],properties:{path:{type:'string'},name:{type:'string'},mediaType:{type:'string'}}}}}}
const instruction='只执行本次任务，使用真实工具，不直接发送聊天消息。完成后提交 text 和 files：text 如实说明成果、失败和未完成项；files 填本任务产物或原会话授权目录中的现有文件，附文件名与 MIME；平台会保存交付副本。附件报告按需提供，files 可以为空；图片、现有产物或简短结果足够时直接交付，不额外写任务报告或验收说明。用户要求文件、详细分析或长资料确有保留价值时再提供完整附件。聊天表达由平台在交付时处理。工作工具按当前工具列表直接调用。'
export const PARTNER_BACKGROUND_PROVIDER={name:'partner-task',capabilities:{agentOptions:true,agentPreset:false,outputSchema:true,depthLimit:true},inheritsParentContext:false,prepareContinuable:async()=>({})}

/** Native activations own execution. The adapter owns frozen channel provenance and delivery receipts. */
export class NativeBackgroundTasks {
 private readonly children=new Map<string,{run:ExecutionRun;parent:Agent;activation?:Activation|undefined;disposeScope?:()=>void;disposers?:Array<()=>void>}>()
 private readonly detachGuard:()=>void
 private readonly detachStore:()=>void
 private readonly detachCreated:()=>void
 private detachProvider:(()=>void)|undefined
 private closing=false
 private recovering=false
 private readonly delivering=new Map<string,Promise<void>>()
 constructor(private readonly ctx:Context,private readonly store:PartnerStore,private readonly deliver:(run:ExecutionRun,reply:PartnerReply)=>Promise<void>){
  this.detachGuard=(ctx.tools as ToolRuntime).guard(exec=>{
   const child=exec.agent&&this.children.get(exec.agent.session.id)
   if(!child){
    if(!exec.agent||!runtimeSessionPolicy(this.store,exec.agent.session.id)?.rules.forceBackground)return
    if(exec.agent&&backgroundWork(exec.name,exec.arguments)){
     const events=exec.agent.session.snapshotEvents();if(!backgroundRequired(exec.name,exec.arguments,events,exec.callId))return
     const state=runtimeSnapshot(this.store),route=backgroundOrigin(exec.agent.session.id,events,state.sessions),channel=state.channels.find(c=>c.id===route?.channelId)
     const eligible=route&&(route.kind==='local'||channel?.enabled&&channelReplyAllowed(state,route.channelId,route.userId)&&(channel.platform!=='qq'||qqIdentityRelation(channel.qq,route.userId)?.matched))
     if(eligible)return '本次工作尚未执行：这是执行型或连续多步任务，必须先通过 partner_background_task action=start 交给原生后台，input 带完整要求、引用路径和已完成进度；接收后前台按人格简短确认并结束，不等待、轮询或重复执行。'
    }
    return
   }
   try{this.authorize(child.run,child.parent)}catch(error){return String(error)}
   const action=actualAction(exec.name,exec.arguments)
   if(forbidden.has(action.name)||['subagent','subagent_fork','fork_agent','spawn_agent','send_message'].includes(action.name)||isPartnerOwnedTool(this.store,child.run.ownerCompanionId,action.name)&&!workTools.has(action.name)&&!isPartnerMcpOperation(this.store,child.run.ownerCompanionId,action.name))return '后台任务只执行当前目标；交付由原会话回传，不直接聊天、改设定或再次委派'
   if(action.name==='partner_bilibili'&&action.args.action==='call'&&['comment','image_dynamic','publish_video'].includes(action.args.operation))return '后台只整理事实和产物；对外发布由原会话按当前人物和授权交付'
   // Native tools retain inherited host approvals; partner operations are narrowed above.
  })
  this.detachCreated=typeof ctx.on==='function'?ctx.on('agent/created',async({agent})=>{
   const child=this.children.get(agent.session.id);if(!child)return
   this.authorize(child.run,child.parent)
   const definitions=child.parent.ctx.tools.definitions(child.parent).filter(t=>workTools.has(t.name)||isPartnerMcpOperation(this.store,child.run.ownerCompanionId,t.name))
   child.disposers=[agent.ctx.systemPrompt.section({name:'partner-background-task',order:-8,interpolate:false,text:instruction}),...definitions.map(t=>agent.ctx.tools.register({...t}))]
   child.disposers.push(nativePresentation(agent.ctx,tools=>tools.filter(t=>!isPartnerOwnedTool(this.store,child.run.ownerCompanionId,t.name)||workTools.has(t.name)||isPartnerMcpOperation(this.store,child.run.ownerCompanionId,t.name))))
  }):()=>{}
  this.detachStore=store.subscribe(()=>{for(const c of this.children.values())try{this.authorize(c.run,c.parent)}catch{void c.activation?.dispose().catch(()=>{})}},()=>{})
 }
 private native():NativeRuntime {
  const service=this.ctx.get('subagents') as unknown as NativeRuntime|undefined
  if(!service?.startActivation||!service.registerProvider)throw Error('当前宿主未提供原生后台任务')
  if(!this.detachProvider){this.detachProvider=service.registerProvider(PARTNER_BACKGROUND_PROVIDER)}
  if(!service.getProvider(PARTNER_BACKGROUND_PROVIDER.name))throw Error('伙伴后台执行器未注册')
  return service
 }
 private authorize(run:ExecutionRun,parent:Agent):void {
  if(this.closing)throw Error('伙伴正在停止')
  const source=run.background!,state=runtimeSnapshot(this.store),c=state.companions.find(c=>c.id===run.ownerCompanionId),route=state.sessions.find(r=>r.id===source.routeId),channel=state.channels.find(c=>c.id===source.channelId)
  if(!c||this.store.isCompanionRemoving(c.id)||!route||route.sessionId!==source.sourceSessionId||route.userId!==source.userId||route.companionId!==c.id||parent.session.id!==source.sourceSessionId||source.capabilities.some(cap=>!c.capabilities.includes(cap as never)))throw Error('后台任务原会话或能力授权已变化')
  if(source.sourceKind==='local'){if(route.kind!=='local')throw Error('后台任务本地来源已变化');return}
  if(route.kind!=='channel'||!channel?.enabled||channel.accountId!==source.accountId||(channel.direct?.baseUrl??'')!==source.baseUrl||directReplyTarget(state,source.channelId,source.userId)!==source.targetId||!channelReplyAllowed(state,source.channelId,source.userId)||channel.platform==='qq'&&!qqIdentityRelation(channel.qq,source.userId)?.matched)throw Error('后台任务需要原发起人的完整伙伴授权')
 }
 tool(owner:string):ToolDefinition {
  return {name:'partner_background_task',description:'当前伙伴会话里明确交办的调查、整理文档、生图、编程等工作（包括一次生图），一旦识别必须先用 start 交给 DSH 原生后台子任务，立刻返回前台；普通闲聊和轻量直接提问不创建任务。input 只写自包含的任务要求、约束和必要文件路径；不要复制聊天记录、人设、原始消息 JSON 或工具回执。后台从空白会话开始，不继承前台历史。后台独立完成并在交付时按原伙伴人设简短接话并按需将已有产物或确有必要的详细资料作为附件送回原会话，不为每个任务额外生成报告，无需轮询、等待或前台重复执行。list/status 查询当前发起人的任务；只有该发起人明确补充或取消时用 update/cancel，不能因群消息变多就修改或取消。cancel 停止运行但保留任务进度，原发起人明确要求继续时用 resume 和原 taskId，可在 input 补充未完成目标；不另建任务或重复已完成操作。只有明确要求彻底放弃并删除任务时用 discard；完成交付后自动回收。',
   parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['start','list','status','update','cancel','resume','discard']},label:{type:'string',maxLength:80},input:{type:'string',maxLength:16000},taskId:{type:'string',maxLength:120}}},
   output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},presentCall:()=>({card:'generic',title:'原生后台任务'}),
   execute:async(raw,exec)=>{
    const args=record(raw),offered=exec.agent;if(!offered)throw Error('任务缺少原会话')
    const registry=this.ctx.get('agents') as {get?:(id:string)=>Agent|undefined}|undefined,parent=registry?.get?.(offered.session.id)??offered
    if(parent.session.id!==offered.session.id)throw Error('后台任务原会话对象不匹配')
    const state=runtimeSnapshot(this.store),events=parent.session.snapshotEvents(),route=backgroundOrigin(parent.session.id,events,state.sessions)
    if(!route||route.companionId!==owner)throw Error('此入口用于来源明确的伙伴会话后台任务')
    const owned=()=>runtimeSnapshot(this.store).executionRuns.filter(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id)
    if(args.action==='list')return {tasks:owned().slice(-12).map(r=>({taskId:r.id,label:r.background!.label,status:r.status,canResume:r.status==='canceled'&&!r.sessionCleanup?.deletedAt&&!r.background!.discardedAt,delivered:!!r.background!.deliveredAt}))}
    if(args.action!=='start'){
     const id=requiredText(args.taskId,'taskId',120),run=owned().find(r=>r.id===id);if(!run)throw Error('此发起人在当前会话没有这项后台任务')
     if(args.action==='status')return {taskId:id,status:run.status,canResume:run.status==='canceled'&&!run.sessionCleanup?.deletedAt&&!run.background!.discardedAt,output:run.outputSummary,error:run.error,delivered:!!run.background!.deliveredAt}
     this.authorize(run,parent)
     if(args.action==='resume'){
      const user=[...events].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user')
      if(user?.type!=='user/message')throw Error('恢复任务需要当前发起人的明确请求')
      if(['queued','running'].includes(run.status)&&run.background!.resumeInputId===user.data.id)return {kind:'partner-background-v1',taskId:id,childSessionId:run.sessionId,status:run.status,alreadyAccepted:true}
      if(run.status!=='canceled'||run.sessionCleanup?.deletedAt||run.background!.discardedAt)throw Error('此任务未暂停或已回收，不能恢复；已删除的任务日志不能重建')
      if(!this.native().resumeActivation)throw Error('当前宿主尚未提供同一后台任务的原生恢复入口')
      const supplement=args.input===undefined?'':requiredText(args.input,'input',16000)
      let claimed=false
      await this.store.update(s=>{const r=s.executionRuns.find(r=>r.id===id);if(!r||r.status!=='canceled'||r.sessionCleanup?.deletedAt||r.background!.discardedAt)throw Error('任务状态已变化，请重新查看');if(s.executionRuns.filter(r=>r.background?.routeId===route.id&&['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务');r.status='queued';delete r.completedAt;delete r.error;r.background!.attempt=(r.background!.attempt??0)+1;r.background!.resumeInputId=user.data.id;claimed=true})
      if(!claimed)throw Error('任务恢复未接收')
      const restored=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id)!
      try{
       const activation=await this.activate(restored,parent,events,exec.signal,'原发起人明确要求继续这个已取消的任务。保留此前任务上下文与已有产物，只推进未完成部分；已完成或结果未知的外部操作先核实，不重复执行。'+(supplement?'\n本次补充：'+supplement:''),true)
       return {kind:'partner-background-v1',taskId:id,childSessionId:run.sessionId,name:activation.name,status:'running',resumed:true,independent:true}
      }catch(error){await this.save(id,r=>{if(r.background?.attempt===restored.background!.attempt){r.status='canceled';r.error='恢复未接收：'+String(error).slice(0,800)}});throw error}
     }
     const child=this.children.get(run.sessionId)
     if(args.action==='cancel'||args.action==='discard'){
      if(!['queued','running','canceled','failed'].includes(run.status))throw Error('任务已完成，不能再次取消或删除')
      await this.save(id,r=>{r.status='canceled';r.completedAt=Date.now();if(args.action==='discard')r.background!.discardedAt=Date.now()})
      await child?.activation?.dispose()
      if(child&&this.children.get(run.sessionId)===child)this.releaseChild(run.sessionId)
      return {taskId:id,canceled:true,canResume:args.action!=='discard'&&!run.sessionCleanup?.deletedAt&&!run.background!.discardedAt,completedActionsPreserved:true,...(args.action==='discard'?{discarded:true}:{})}
     }
     if(!child?.activation||!['queued','running'].includes(run.status))throw Error('任务当前不在执行，明确要求继续时使用 resume')
     this.authorize(run,parent)
     if(args.action!=='update')throw Error('未知后台任务操作')
     const input=requiredText(args.input,'input',16000);this.authorize(run,child.parent)
     await this.native().sendMessage(parent,run.sessionId,[{type:'text',text:'原发起人对本任务的明确补充；仅调整未完成部分，不重复已完成的调用和交付：\n'+input}],{signal:exec.signal})
     return {taskId:id,updated:true}
    }
    const native=this.native(),label=requiredText(args.label,'label',80)
    if(typeof args.input!=='string'||!args.input.trim()||args.input.length>16000)throw Error('input 需要 1–16000 字的自包含任务')
    const input=args.input.trim()
    const user=[...events].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user');if(user?.type!=='user/message')throw Error('没有当前用户输入')
    const prior=owned().find(r=>r.background!.inputId===user.data.id);if(prior)return {kind:'partner-background-v1',taskId:prior.id,status:prior.status,alreadyAccepted:true}
    if(owned().filter(r=>['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务')
    const id='background-'+randomUUID(),childId='session-'+randomUUID(),cwd=join(parent.session.header.cwd??'/tmp','.partner-background',id),channel=state.channels.find(c=>c.id===route.channelId)!,c=state.companions.find(c=>c.id===owner)!
    const run:ExecutionRun={id,kind:'work',ownerCompanionId:owner,sessionId:childId,sourceId:id,status:'queued',destroyAfterRun:false,startedAt:Date.now(),toolNames:[],background:{routeId:route.id,sourceSessionId:route.sessionId,channelId:route.channelId,userId:route.userId,inputId:user.data.id,sourceKind:route.kind,sourceCwd:parent.session.header.cwd??'/tmp',accountId:channel?.accountId??'',baseUrl:channel?.direct?.baseUrl??'',targetId:route.kind==='local'?'':directReplyTarget(state,route.channelId,route.userId),label,cwd,capabilities:[...c.capabilities]}}
    this.authorize(run,parent);await mkdir(cwd,{recursive:true,mode:0o700})
    let existing:ExecutionRun|undefined
    await this.store.update(s=>{existing=s.executionRuns.find(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id&&r.background.inputId===user.data.id);if(existing)return;if(s.executionRuns.filter(r=>r.background?.routeId===route.id&&['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务');if(s.executionRuns.length>=500){const i=s.executionRuns.findIndex(r=>!['queued','running'].includes(r.status)&&(r.status!=='canceled'||!!r.background?.discardedAt)&&!(r.background?.result&&!r.background.deliveredAt));if(i<0)throw Error('任务记录已满');s.executionRuns.splice(i,1)}s.executionRuns.push(run)})
    if(existing)return {kind:'partner-background-v1',taskId:existing.id,status:existing.status,alreadyAccepted:true}
    const activation=await this.activate(run,parent,events,exec.signal,input,false)
    if(runtimePolicy(this.store,owner)?.rules.taskPreamble&&hasTaskPreamble(parent.session.snapshotEvents()))exec.concludeTurn()
    return {kind:'partner-background-v1',taskId:id,childSessionId:childId,name:activation.name,status:'running',independent:true}
   }}
 }
 private async activate(run:ExecutionRun,parent:Agent,events:ReturnType<Agent['session']['snapshotEvents']>,signal:AbortSignal,input:string,resume:boolean):Promise<Activation>{
  const native=this.native(),childId=run.sessionId,id=run.id,attempt=run.background!.attempt??0,route=runtimeSnapshot(this.store).sessions.find(r=>r.id===run.background!.routeId)!
  const child:{run:ExecutionRun;parent:Agent;activation?:Activation;disposeScope?:()=>void;disposers?:Array<()=>void>}={run,parent};this.children.set(childId,child)
  const release=()=>{if(this.children.get(childId)===child)this.releaseChild(childId)}
  try{
   child.disposeScope=bindBackgroundScope(this.store,childId,{owner:run.ownerCompanionId,browserScope:browserAudience(run.ownerCompanionId,parent.session.id,events,runtimeSnapshot(this.store))??JSON.stringify([route.channelId,route.userId]),authorize:()=>this.authorize(run,parent)})
   const spec={provider:PARTNER_BACKGROUND_PROVIDER.name,childId,parent,signal,delivery:'caller',label:run.background!.label,cwd:run.background!.cwd,prompt:[{type:'text',text:input}],outputSchema,maxDepth:Math.min(1,native.resolveMaxDepth?.()??1)}
   child.activation=resume?await native.resumeActivation!(spec):await native.startActivation(spec)
   this.authorize(run,parent)
   if(runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id)?.status==='canceled')throw Error('任务已被取消')
   await this.save(id,r=>{if(r.status!=='canceled'&&(r.background!.attempt??0)===attempt){r.status='running';r.background!.childName=child.activation!.name}})
   void child.activation.result.then(result=>this.finished(id,result,attempt).catch(error=>this.failed(id,error,attempt)),error=>this.failed(id,error,attempt)).finally(release).catch(error=>this.ctx.logger.warn('后台任务收尾失败：'+String(error)))
   return child.activation
  }catch(error){await child.activation?.dispose().catch(()=>{});release();if(!resume)await this.failed(id,error,attempt);throw error}
 }
 private releaseChild(id:string):void {const child=this.children.get(id);child?.disposeScope?.();for(const dispose of child?.disposers?.reverse()??[])dispose();this.children.delete(id)}
 private async save(id:string,mutate:(run:ExecutionRun)=>void):Promise<void>{await this.store.update(s=>{const run=s.executionRuns.find(r=>r.id===id);if(run)mutate(run)})}
 private async failed(id:string,error:unknown,attempt?:number):Promise<void>{await this.save(id,r=>{if(r.status==='canceled'||attempt!==undefined&&(r.background!.attempt??0)!==attempt)return;r.status='failed';r.completedAt=Date.now();r.error=String(error).slice(0,1000)})}
 private async finished(id:string,result:{stopReason:string;structured?:unknown},attempt?:number):Promise<void>{
  const run=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id);if(!run||run.status==='canceled'||this.closing||attempt!==undefined&&(run.background!.attempt??0)!==attempt)return
  if(result.stopReason!=='completed')return this.failed(id,'原生后台任务结束状态：'+result.stopReason,attempt)
  const value=record(result.structured)
  if(typeof value.text!=='string'||!value.text.trim())throw Error('后台结果正文不能为空')
  const text=value.text,files=[] as {path:string;name:string;mediaType:string}[]
  if(!Array.isArray(value.files)||value.files.length>8)throw Error('后台产物列表无效')
  const root=await realpath(run.background!.cwd)
  const source=run.background!.sourceCwd??(basename(dirname(root))==='.partner-background'&&basename(root)===run.id?dirname(dirname(root)):undefined)
  const sourceRoot=source?await realpath(source):undefined
  for(const entry of value.files){
   const file=record(entry);let path=await realpath(resolve(root,requiredText(file.path,'path',4000)))
   if(!(await stat(path)).isFile())throw Error('后台产物不是文件')
   if(!path.startsWith(root+sep)){
    if(!sourceRoot||!path.startsWith(sourceRoot+sep))throw Error('后台产物不在本任务工作目录内')
    const copied=join(root,'artifacts',randomUUID()+'-'+basename(path));await mkdir(dirname(copied),{recursive:true,mode:0o700});await copyFile(path,copied,1);path=copied
   }
   files.push({path,name:requiredText(file.name,'name',240)||basename(path),mediaType:requiredText(file.mediaType,'mediaType',200)})
  }
  let committed=false
  await this.save(id,r=>{if(r.status==='canceled'||attempt!==undefined&&(r.background!.attempt??0)!==attempt)return;committed=true;r.status='completed';delete r.error;r.completedAt=Date.now();r.outputSummary=text;r.background!.result={text,files}})
  if(committed)await this.deliverResult(id)
 }
 private deliverResult(id:string):Promise<void>{
  const prior=this.delivering.get(id);if(prior)return prior
  const pending=this.deliverResultOnce(id).finally(()=>this.delivering.delete(id));this.delivering.set(id,pending);return pending
 }
 private async deliverResultOnce(id:string):Promise<void>{
  const run=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id);if(!run?.background?.result||run.background.deliveredAt)return
  const b=run.background,reply:PartnerReply={text:b.result!.text,attachments:b.result!.files.map(f=>({...f,kind:'file'}))}
  try{await this.deliver(run,reply);await this.save(id,r=>{r.background!.deliveredAt=Date.now();delete r.background!.deliveryError})}catch(error){await this.save(id,r=>{r.background!.deliveryError=String(error).slice(0,1000)})}
 }
 private async recoverSavedOutput(run:ExecutionRun):Promise<void>{
  const persistence=this.ctx.get('sessionPersistence') as {open?:(id:string,mode:'read')=>Promise<{header:{parentSession?:string};inheritedEventCount:number;read(offset?:number):Promise<{events:import('@deepseek-ai/dsh-session').SessionEvent[]}>;close():Promise<void>}>}|undefined
  if(!persistence?.open)return
  const handle=await persistence.open(run.sessionId,'read')
  try{
   if(handle.header.parentSession!==run.background!.sourceSessionId)throw Error('后台恢复来源不匹配')
   const {events}=await handle.read(handle.inheritedEventCount)
   const end=[...events].reverse().find(e=>e.type==='turn/end')
   if(end?.type!=='turn/end'||end.data.reason.kind!=='completed')return
   const call=[...events].reverse().find(e=>e.type==='tool/call'&&e.data.name==='structured_output')
   if(call?.type==='tool/call')await this.finished(run.id,{stopReason:'completed',structured:typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments})
  }finally{await handle.close()}
 }
 async recoverDeliveries():Promise<void>{if(this.closing||this.recovering)return;this.recovering=true;try{for(const r of runtimeSnapshot(this.store).executionRuns){if(r.background&&['queued','running'].includes(r.status)&&!this.children.has(r.sessionId)&&!(this.ctx.get('agents') as {get?:(id:string)=>unknown}|undefined)?.get?.(r.sessionId)){await this.save(r.id,run=>{if(['queued','running'].includes(run.status)){run.status='canceled';run.completedAt=Date.now();run.error='服务已重启，任务保留进度等待原发起人明确继续'}})}else if(r.background&&r.status==='failed'&&r.error?.includes('后台产物不在本任务工作目录内')){try{await this.recoverSavedOutput(r)}catch(error){this.ctx.logger.warn('后台已保存成果恢复暂未完成：'+String(error))}}else if(r.background?.result&&r.status==='completed'&&!r.background.deliveredAt)await this.deliverResult(r.id)}}finally{this.recovering=false}}
 async close():Promise<void>{this.closing=true;this.detachStore();await Promise.allSettled([...this.children.values()].map(c=>c.activation?.dispose()));for(const id of this.children.keys())this.releaseChild(id);this.detachCreated();this.detachProvider?.();this.detachGuard()}
}
