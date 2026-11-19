import {MAX_BACKGROUND_RETRIES,backgroundFollowup,offloadBackgroundImages,retryMode} from './background-retry.js'
import {renderBackgroundImageReferences,type PartnerImageReferences} from '../attachments/image-references.js'
import {runtimeSnapshot,runtimePolicy,runtimeSessionPolicy} from '../companions/runtime-policy.js'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {reviewEvidence,diagnostic} from './background-review.js'
import {randomUUID} from 'node:crypto'
import {mkdir,realpath,stat,copyFile} from 'node:fs/promises'
import {join,resolve,sep,basename,dirname} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolDefinition,ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'
import type {PartnerReply} from '../channel-message.js'
import {activityPolicyCurrent} from '../character/post-reply.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {backgroundOrigin,backgroundInput,backgroundSourceAllowed,backgroundRunRoute,backgroundRequired,backgroundWork} from './background-routing.js'
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
interface ActiveChild {run:ExecutionRun;parent:Agent;agent?:Agent;finalizing?:boolean;fault?:string;activation?:Activation|undefined;disposeScope?:()=>void;disposers?:Array<()=>void>}
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
const outputSchema={type:'object',additionalProperties:false,required:['text','files'],properties:{text:{type:'string'},files:{type:'array',description:'本次交付附件，最多八个',items:{type:'object',additionalProperties:false,required:['path','name','mediaType'],properties:{path:{type:'string'},name:{type:'string'},mediaType:{type:'string'}}}}}}
const instruction='只执行本次任务，使用真实工具，不直接发送聊天消息。完成后提交 text 和 files：text 如实说明成果、失败和未完成项；files 只填本次需要交付的产物，附文件名与 MIME；输入参考图、已发布到其他地方的原图不因任务中使用过就再作为附件返回。仅当用户明确要求发送该现有文件时交付原文件；平台会保存交付副本。附件报告按需提供，files 可以为空，单次最多八个附件；超过时按需要打包已有文件，无法打包也要提交已有进度并说明剩余项。图片、现有产物或简短结果足够时直接交付，不额外写任务报告或验收说明。用户要求文件、详细分析或长资料确有保留价值时再提供完整附件。聊天表达由平台在交付时处理。工作工具按当前工具列表直接调用。'
export const PARTNER_BACKGROUND_PROVIDER={name:'partner-task',capabilities:{agentOptions:true,agentPreset:false,outputSchema:true,depthLimit:true},inheritsParentContext:false,prepareContinuable:async()=>({})}

/** Native activations own execution. The adapter owns frozen channel provenance and delivery receipts. */
export class NativeBackgroundTasks {
 private readonly children=new Map<string,ActiveChild>()
 private readonly reviews=new Map<string,Promise<void>>()
 private readonly detachGuard:()=>void
 private readonly detachStore:()=>void
 private readonly detachCreated:()=>void
 private detachProvider:(()=>void)|undefined
 private closing=false
 private recovering=false
 private readonly delivering=new Map<string,Promise<void>>()
 constructor(private readonly ctx:Context,private readonly store:PartnerStore,private readonly deliver:(run:ExecutionRun,reply:PartnerReply)=>Promise<void>,private readonly preferences?:(run:ExecutionRun,input:string)=>Promise<string>,private readonly review?:(run:ExecutionRun)=>Promise<unknown>,private readonly images?:PartnerImageReferences){
  this.detachGuard=(ctx.tools as ToolRuntime).guard(exec=>{
   const child=exec.agent&&this.children.get(exec.agent.session.id)
   if(!child){
    if(!exec.agent||!runtimeSessionPolicy(this.store,exec.agent.session.id)?.rules.forceBackground)return
    if(exec.agent&&backgroundWork(exec.name,exec.arguments)){
     const events=exec.agent.session.snapshotEvents();if(!backgroundRequired(exec.name,exec.arguments,events,exec.callId))return
     const state=runtimeSnapshot(this.store),input=backgroundInput(events),route=backgroundOrigin(exec.agent.session.id,events,state.sessions,input),channel=state.channels.find(c=>c.id===route?.channelId)
     const eligible=route&&(route.kind==='local'||channel?.enabled&&channelReplyAllowed(state,route.channelId,route.userId))
     if(!eligible&&input&&isIdleContactNotice(input))return '当前自主活动的投递来源已失效，本次工作未执行'
     if(eligible)return '本次工作尚未执行：这是执行型或连续多步任务，必须先通过 partner_background_task action=start 交给原生后台；同一任务正在执行且本轮是补充或修正时使用 update 和原 taskId；新任务的 input 带完整要求、引用编号和已完成进度。接收后前台简短确认并结束，不等待、轮询或重复执行。'
    }
    return
   }
   try{this.authorize(child.run,child.parent)}catch(error){return String(error)}
   if(exec.name==='structured_output'){
    const output=exec.arguments as {files?:unknown[];text?:string}|undefined
    if(typeof output?.text!=='string'||!output.text.trim()||!Array.isArray(output.files)||output.files.length>8)
     return '交付清单需要非空 text 和最多八个 files；超出时使用已有打包文件，或选取本次可交付部分并在 text 说明剩余项，不要重新生成。'
   }
   if(child.finalizing&&exec.name!=='structured_output')return '当前只补交已有成果清单，请调用 structured_output；不能重新执行工作'
   const action=actualAction(exec.name,exec.arguments)
   if(!this.childToolAllowed(child.run,exec.name)||!this.childToolAllowed(child.run,action.name))return '原发起人的工具范围不包含此伙伴能力'
   if(forbidden.has(action.name)||['subagent','subagent_fork','fork_agent','spawn_agent','send_message'].includes(action.name)||isPartnerOwnedTool(this.store,child.run.ownerCompanionId,action.name)&&!workTools.has(action.name)&&!isPartnerMcpOperation(this.store,child.run.ownerCompanionId,action.name))return '后台任务只执行当前目标；交付由原会话回传，不直接聊天、改设定或再次委派'
   if(action.name==='partner_bilibili'&&action.args.action==='call'&&['comment','image_dynamic','publish_video'].includes(action.args.operation))return '后台只整理事实和产物；对外发布由原会话按当前人物和授权交付'
   // Native tools retain inherited host approvals; partner operations are narrowed above.
  })
  this.detachCreated=typeof ctx.on==='function'?ctx.on('agent/created',async({agent})=>{
   const child=this.children.get(agent.session.id);if(!child)return
   this.authorize(child.run,child.parent)
   const definitions=child.parent.ctx.tools.definitions(child.parent).filter(t=>this.childToolAllowed(child.run,t.name)&&(workTools.has(t.name)||isPartnerMcpOperation(this.store,child.run.ownerCompanionId,t.name)))
   const workspace='\n任务文件位置（路径资料，不是额外授权）：'+JSON.stringify({sourceDirectory:child.run.background!.sourceCwd,taskDirectory:child.run.background!.cwd})+'\n按任务需要在源目录核对已有素材。generate_image 只使用本次确认的图片编号或明确授权的文件，由平台直接读取；不要用符号链接绕过目录校验，不因路径不同就省略参考图或改用无关图片。'
   child.disposers=[agent.ctx.systemPrompt.section({name:'partner-background-task',order:-8,interpolate:false,text:instruction+workspace}),...definitions.map(t=>agent.ctx.tools.register({...t}))]
   child.agent=agent
   if(child.run.background!.retryMode==='images')offloadBackgroundImages(agent.session)
   if(child.run.background!.retryMode==='manifest')child.finalizing=true
   let submitted=false
   child.disposers.push(ctx.on('tools/result',(exec,result)=>{if(exec.agent?.session.id===agent.session.id&&exec.name==='structured_output'&&!result.isError)submitted=true}))
   child.disposers.push(ctx.on('agent/error',event=>{if(event.agent.session.id===agent.session.id)child.fault=diagnostic(event.error)}))
   child.disposers.push(ctx.on('agent/turn-stopping',event=>{
    if(event.agent.session.id!==agent.session.id||event.signal.aborted||submitted||child.finalizing)return
    child.finalizing=true
    agent.steer(createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'补交后台任务清单'},content:[{type:'text',text:'本轮结束前只需调用 structured_output 并提交 text 和 files。根据已有工具回执列出实际完成的内容和需交付的文件；未完成部分如实说明。不要再次生图或执行其他操作。'}]}))
   }))
   child.disposers.push(nativePresentation(agent.ctx,tools=>tools.filter(t=>this.childToolAllowed(child.run,t.name)&&(!isPartnerOwnedTool(this.store,child.run.ownerCompanionId,t.name)||workTools.has(t.name)||isPartnerMcpOperation(this.store,child.run.ownerCompanionId,t.name)))))
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
 private childToolAllowed(run:ExecutionRun,name:string):boolean{
  if(run.background?.audience&&name!=='structured_output'&&!run.toolNames.includes(name))return false
  if(run.background?.audience!=='member')return true
  if(name==='partner_browser'||name==='partner_bilibili')return true
  return !workTools.has(name)&&!isPartnerOwnedTool(this.store,run.ownerCompanionId,name)&&!isPartnerMcpOperation(this.store,run.ownerCompanionId,name)
 }
 private authorize(run:ExecutionRun,parent:Agent):void {
  if(this.closing)throw Error('伙伴正在停止')
  if(this.store.isCompanionRemoving(run.ownerCompanionId)||parent.session.id!==run.background?.sourceSessionId||!backgroundSourceAllowed(runtimeSnapshot(this.store),run))throw Error('后台任务原会话或能力授权已变化')
 }
 tool(owner:string):ToolDefinition {
  return {name:'partner_background_task',description:'任何发言人交办或伙伴自主活动决定执行的调查、整理文档、生图、编程等工作（包括一次生图），一旦识别必须先用 start 交给 DSH 原生后台子任务，立刻返回前台；普通闲聊、轻量直接提问、准备好内容后的一次渠道发布（例如发说说）不创建任务，后者由原会话调用渠道工具。input 只写自包含的任务要求、约束和必要文件路径；不要复制聊天记录、人设、原始消息 JSON 或工具回执。后台从空白会话开始，不继承前台历史。后台独立完成并在交付时按原伙伴人设简短接话并按需将已有产物或确有必要的详细资料作为附件送回原会话，不为每个任务额外生成报告，无需轮询、等待或前台重复执行。list/status 查询当前发起人的任务；同一发起人补充或修正正在做的同一个任务时必须用 update 和原 taskId，只提交调整项；只在明确其他目标时 start。取消或放弃按原发起人要求执行。cancel 停止运行但保留任务进度，原发起人明确要求继续时用 resume 和原 taskId，可在 input 补充未完成目标；不另建任务或重复已完成操作。只有明确要求彻底放弃并删除任务时用 discard；完成交付后自动回收。',
   parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['start','list','status','update','cancel','resume','discard']},label:{type:'string',maxLength:80},input:{type:'string',maxLength:16000},taskId:{type:'string',maxLength:120}}},
   output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},presentCall:()=>({card:'generic',title:'原生后台任务'}),
   execute:async(raw,exec)=>{
    const args=record(raw),offered=exec.agent;if(!offered)throw Error('任务缺少原会话')
    const registry=this.ctx.get('agents') as {get?:(id:string)=>Agent|undefined}|undefined,parent=registry?.get?.(offered.session.id)??offered
    if(parent.session.id!==offered.session.id)throw Error('后台任务原会话对象不匹配')
    const state=runtimeSnapshot(this.store),events=parent.session.snapshotEvents(),user=backgroundInput(events),route=backgroundOrigin(parent.session.id,events,state.sessions,user)
    if(!user||!route||route.companionId!==owner)throw Error('此入口用于来源明确的伙伴会话后台任务')
    const channel=state.channels.find(c=>c.id===route.channelId),c=state.companions.find(c=>c.id===owner)!
    const activity=isIdleContactNotice(user)
    if(activity&&(!c||!activityPolicyCurrent(state,c,route)))throw Error('自主活动授权已变化')
    if(route.kind==='channel'&&(!channel?.enabled||channel.companionId!==owner||!channelReplyAllowed(state,route.channelId,route.userId)))throw Error('渠道授权已变化')
    const audience=activity?'activity':channel?.platform==='qq'&&!qqIdentityRelation(channel.qq,route.userId)?.matched?'member':undefined
    const owned=()=>runtimeSnapshot(this.store).executionRuns.filter(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id&&(r.background.audience===audience||audience===undefined&&r.background.audience==='member'))
    if(args.action==='list')return {tasks:owned().slice(-12).map(r=>({taskId:r.id,label:r.background!.label,status:r.status,retries:r.background!.retries??0,canResume:r.status==='canceled'&&!r.sessionCleanup?.deletedAt&&!r.background!.discardedAt&&!r.background!.stoppedAt,delivered:!!r.background!.deliveredAt}))}
    if(args.action!=='start'){
     const id=requiredText(args.taskId,'taskId',120),run=owned().find(r=>r.id===id);if(!run)throw Error('此发起人在当前会话没有这项后台任务')
     if(args.action==='status')return {taskId:id,status:run.status,retries:run.background!.retries??0,canResume:run.status==='canceled'&&!run.sessionCleanup?.deletedAt&&!run.background!.discardedAt&&!run.background!.stoppedAt,...(run.outputSummary!==undefined?{output:run.outputSummary}:{}),...(run.error!==undefined?{error:run.error}:{}),delivered:!!run.background!.deliveredAt}
     this.authorize(run,parent)
     if(args.action==='resume'){
      const user=[...events].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user')
      if(user?.type!=='user/message')throw Error('恢复任务需要当前发起人的明确请求')
      if(['queued','running'].includes(run.status)&&run.background!.resumeInputId===user.data.id)return {kind:'partner-background-v1',taskId:id,childSessionId:run.sessionId,status:run.status,alreadyAccepted:true}
      if(run.status!=='canceled'||run.sessionCleanup?.deletedAt||run.background!.discardedAt||run.background!.stoppedAt)throw Error('此任务未暂停或已回收，不能恢复；已删除的任务日志不能重建')
      if(!this.native().resumeActivation)throw Error('当前宿主尚未提供同一后台任务的原生恢复入口')
      const supplement=args.input===undefined?'':requiredText(args.input,'input',16000)
      const imageReferences=this.images?.plan(parent,route,user.data.id)
      let claimed=false
      await this.store.update(s=>{const r=s.executionRuns.find(r=>r.id===id);if(!r||r.status!=='canceled'||r.sessionCleanup?.deletedAt||r.background!.discardedAt)throw Error('任务状态已变化，请重新查看');if(s.executionRuns.filter(r=>r.background?.routeId===route.id&&['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务');r.status='queued';delete r.completedAt;delete r.error;r.background!.attempt=(r.background!.attempt??0)+1;r.background!.resumeInputId=user.data.id;delete r.background!.retryMode;r.background!.retries=0;if(imageReferences)r.background!.imageReferences=imageReferences;else if(r.background!.imageReferences?.files)delete r.background!.imageReferences;delete r.background!.review;delete r.background!.foregroundMessageId;delete r.background!.foregroundReply;claimed=true})
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
      await this.save(id,r=>{r.status='canceled';r.completedAt=Date.now();delete r.background!.retryMode;delete r.background!.review;if(!r.background!.deliveredAt)delete r.background!.result;if(args.action==='discard')r.background!.discardedAt=Date.now()})
      await child?.activation?.dispose()
      if(child&&this.children.get(run.sessionId)===child)this.releaseChild(run.sessionId)
      return {taskId:id,canceled:true,canResume:args.action!=='discard'&&!run.sessionCleanup?.deletedAt&&!run.background!.discardedAt&&!run.background!.stoppedAt,completedActionsPreserved:true,...(args.action==='discard'?{discarded:true}:{})}
     }
     if(!child?.activation||!['queued','running'].includes(run.status))throw Error('任务当前不在执行，明确要求继续时使用 resume')
     this.authorize(run,parent)
     if(args.action!=='update')throw Error('未知后台任务操作')
     const input=requiredText(args.input,'input',16000)
     const imageReferences=this.images?.plan(parent,route,user.data.id)
     return this.adoptSupplement(run,parent,exec.signal,user.data.id,input,imageReferences)
    }
    const native=this.native(),label=requiredText(args.label,'label',80)
    if(typeof args.input!=='string'||!args.input.trim()||args.input.length>16000)throw Error('input 需要 1–16000 字的自包含任务')
    const input=args.input.trim()
    const imageReferences=this.images?.plan(parent,route,user.data.id)
    const prior=owned().find(r=>r.background!.inputId===user.data.id||r.background!.supplementInputIds?.includes(user.data.id));if(prior)return {kind:'partner-background-v1',taskId:prior.id,status:prior.status,alreadyAccepted:true}
    const followup=backgroundFollowup(owned(),label,input,events,user.data.id)
    if(followup)return this.adoptSupplement(followup,parent,exec.signal,user.data.id,input,imageReferences)
    const id='background-'+randomUUID(),childId='session-'+randomUUID(),cwd=join(parent.session.header.cwd??'/tmp','.partner-background',id)
    let toolNames:string[]=[]
    if(audience){
     if(exec.toolSet){
      let admitted=exec.toolSet.view(offered)
      if(!admitted.size&&parent!==offered)admitted=exec.toolSet.view(parent)
      if(!admitted.size)throw Error('当前回合的工具授权已结束，后台任务未启动')
      toolNames=[...admitted.keys()]
     }else toolNames=parent.ctx.tools.definitions(parent).map(t=>t.name)
    }
    const run:ExecutionRun={id,kind:'work',ownerCompanionId:owner,sessionId:childId,sourceId:id,status:'queued',destroyAfterRun:false,startedAt:Date.now(),toolNames,background:{...(imageReferences?{imageReferences}:{}),...(audience?{audience}:{}),...(activity?{activityKind:route.idleContactState?.kind}:{}),routeId:route.id,sourceSessionId:route.sessionId,channelId:route.channelId,userId:route.userId,inputId:user.data.id,sourceKind:route.kind,sourceCwd:parent.session.header.cwd??'/tmp',accountId:channel?.accountId??'',baseUrl:channel?.direct?.baseUrl??'',targetId:route.kind==='local'?'':directReplyTarget(state,route.channelId,route.userId),label,input,cwd,capabilities:[...c.capabilities]}}
    this.authorize(run,parent);await mkdir(cwd,{recursive:true,mode:0o700})
    let existing:ExecutionRun|undefined
    await this.store.update(s=>{existing=s.executionRuns.find(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id&&(r.background.inputId===user.data.id||r.background.supplementInputIds?.includes(user.data.id)));if(existing)return;existing=backgroundFollowup(s.executionRuns.filter(r=>r.ownerCompanionId===owner&&r.background?.routeId===route.id&&r.background.audience===audience),label,input,events,user.data.id);if(existing)return;if(s.executionRuns.filter(r=>r.background?.routeId===route.id&&['queued','running'].includes(r.status)).length>=3)throw Error('当前发起人已有三项执行中的后台任务');if(s.executionRuns.length>=500){const i=s.executionRuns.findIndex(r=>!['queued','running'].includes(r.status)&&(r.status!=='canceled'||!!r.background?.discardedAt)&&!(r.background?.review&&!r.background.review.doneAt)&&!(r.background?.result&&!r.background.deliveredAt));if(i<0)throw Error('任务记录已满');s.executionRuns.splice(i,1)}s.executionRuns.push(run)})
    if(existing){
     if(existing.background!.inputId!==user.data.id&&!existing.background!.supplementInputIds?.includes(user.data.id))
      return this.adoptSupplement(existing,parent,exec.signal,user.data.id,input,imageReferences)
     return {kind:'partner-background-v1',taskId:existing.id,status:existing.status,alreadyAccepted:true}
    }
    const activation=await this.activate(run,parent,events,exec.signal,input,false)
    if(runtimePolicy(this.store,owner)?.rules.taskPreamble&&hasTaskPreamble(parent.session.snapshotEvents()))exec.concludeTurn()
    return {kind:'partner-background-v1',taskId:id,childSessionId:childId,name:activation.name,status:'running',independent:true}
   }}
 }
 private async adoptSupplement(run:ExecutionRun,parent:Agent,signal:AbortSignal,inputId:string,input:string,referencePlan:NonNullable<ExecutionRun['background']>['imageReferences']){
  this.authorize(run,parent)
  const child=this.children.get(run.sessionId)
  if(!child?.activation)throw Error('同一后台任务正在启动或恢复；补充还未送达，请稍后对原 taskId 使用 update。')
  let claimed=false
  await this.save(run.id,r=>{
   const b=r.background!
   if(r.status!=='running'||b.supplementInputIds?.includes(inputId))return
   b.supplementInputIds=[...b.supplementInputIds??[],inputId];claimed=true
   if(referencePlan?.requested||!b.imageReferences&&referencePlan)b.imageReferences=referencePlan
  })
  if(claimed){
   if(referencePlan?.requested)child.run.background!.imageReferences=referencePlan
   try{await this.native().sendMessage(parent,run.sessionId,[{type:'text',text:'原发起人补充同一项任务。以下是修正后的要求；保留可用进展，只改受影响部分。\n'+input+(referencePlan?.requested?'\n'+renderBackgroundImageReferences(referencePlan):'')}],{signal})}
   catch(error){await this.save(run.id,r=>{const ids=r.background?.supplementInputIds;if(ids)r.background!.supplementInputIds=ids.filter(id=>id!==inputId)});throw error}
  }
  return {kind:'partner-background-v1',taskId:run.id,childSessionId:run.sessionId,status:'running',alreadyAccepted:true,updated:claimed}
 }
 private async activate(run:ExecutionRun,parent:Agent,events:ReturnType<Agent['session']['snapshotEvents']>,signal:AbortSignal,input:string,resume:boolean):Promise<Activation>{
  const native=this.native(),childId=run.sessionId,id=run.id,attempt=run.background!.attempt??0,route=backgroundRunRoute(runtimeSnapshot(this.store).sessions,run)!
  const child:ActiveChild={run,parent};this.children.set(childId,child)
  const release=()=>{if(this.children.get(childId)===child)this.releaseChild(childId)}
  try{
   child.disposeScope=bindBackgroundScope(this.store,childId,{owner:run.ownerCompanionId,audience:run.background!.audience,browserScope:browserAudience(run.ownerCompanionId,parent.session.id,events,runtimeSnapshot(this.store))??JSON.stringify([route.channelId,route.userId]),authorize:()=>this.authorize(run,parent)})
   const companion=runtimeSnapshot(this.store).companions.find(c=>c.id===run.ownerCompanionId)
   const preferences=companion?.characterCard?.enabled&&companion.automation?.memory?.enabled?await this.preferences?.(run,input):undefined
   this.authorize(run,parent)
   const images=run.background!.imageReferences
   const referenceContext=images?renderBackgroundImageReferences(images):''
   const prompt=[{type:'text',text:input},...(referenceContext?[{type:'text',text:referenceContext}]:[]),...(preferences?[{type:'text',text:preferences}]:[])]
   const spec={provider:PARTNER_BACKGROUND_PROVIDER.name,childId,parent,signal,delivery:'caller',label:run.background!.label,cwd:run.background!.cwd,prompt,outputSchema,maxDepth:Math.min(1,native.resolveMaxDepth?.()??1)}
   child.activation=resume?await native.resumeActivation!(spec):await native.startActivation(spec)
   this.authorize(run,parent)
   if(runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id)?.status==='canceled')throw Error('任务已被取消')
   await this.save(id,r=>{if(r.status!=='canceled'&&(r.background!.attempt??0)===attempt){r.status='running';r.background!.childName=child.activation!.name}})
   void child.activation.result.then(result=>this.finished(id,result,attempt).catch(error=>this.failed(id,error,attempt,false,result.structured)),error=>this.failed(id,error,attempt)).finally(release).catch(error=>this.ctx.logger.warn('后台任务收尾失败：'+String(error)))
   return child.activation
  }catch(error){await child.activation?.dispose().catch(()=>{});release();if(!resume)await this.failed(id,error,attempt);throw error}
 }
 private releaseChild(id:string):void {const child=this.children.get(id);child?.disposeScope?.();for(const dispose of child?.disposers?.reverse()??[])dispose();this.children.delete(id)}
 private async save(id:string,mutate:(run:ExecutionRun)=>void):Promise<void>{await this.store.update(s=>{const run=s.executionRuns.find(r=>r.id===id);if(run)mutate(run)})}
 private async readChildEvents(run:ExecutionRun):Promise<readonly SessionEvent[]>{
  const agent=this.children.get(run.sessionId)?.agent
  if(agent){try{const events=agent.session.snapshotEvents();if(events.length)return events}catch{/* The host may already have disposed the child. */}}
  const persistence=this.ctx.get('sessionPersistence') as {open?:(id:string,mode:'read')=>Promise<{header:{parentSession?:string};inheritedEventCount:number;read(offset:number):Promise<{events:SessionEvent[]}>;close():Promise<void>}>}|undefined
  if(!persistence?.open||run.sessionCleanup?.deletedAt)return []
  const handle=await persistence.open(run.sessionId,'read')
  try{return handle.header.parentSession===run.background!.sourceSessionId?(await handle.read(handle.inheritedEventCount)).events:[]}finally{await handle.close()}
 }
 private async failed(id:string,error:unknown,attempt?:number,restart=false,structured?:unknown):Promise<void>{
  if(this.closing)return
  const run=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id)
  if(!run?.background||run.status==='canceled'||run.background.result||attempt!==undefined&&(run.background.attempt??0)!==attempt)return
  const child=this.children.get(run.sessionId)
  const reason=[diagnostic(error),child?.fault].filter(Boolean).join('；')
  const events=await this.readChildEvents(run).catch(()=>[])
  const review=await reviewEvidence(run,events,reason,structured).catch(e=>({reason:reason+'；整理回执失败：'+diagnostic(e),tools:[],files:[],canResume:!!events.length&&!run.background?.reviewResumed}))
  const retry=!restart&&(run.background.retries??0)<MAX_BACKGROUND_RETRIES&&review.canResume?retryMode(review.reason):undefined
  review.canResume=review.canResume&&typeof (this.ctx.get('subagents') as NativeRuntime|undefined)?.resumeActivation==='function'
  await this.save(id,r=>{
   if(r.status==='canceled'||r.background!.result||attempt!==undefined&&(r.background!.attempt??0)!==attempt)return
   r.status=restart?'canceled':'failed';r.completedAt=Date.now();r.error=review.reason;r.background!.review=review
   if(retry)r.background!.retryMode=retry
   else delete r.background!.retryMode
   if((r.background!.retries??0)>=MAX_BACKGROUND_RETRIES)r.background!.review.canResume=false
  })
  // The original tool call may still own the foreground queue. Never wait for its own review here.
  if(child&&this.children.get(run.sessionId)===child)this.releaseChild(run.sessionId)
  if(this.review||retry) this.queueOutcome(id)
 }
 private queueOutcome(id:string):void {
  const pending=this.reviews.get(id)
  void (pending?pending.then(()=>this.reviewOnce(id)):this.reviewOnce(id)).catch(e=>this.ctx.logger.warn('后台失败交接：'+diagnostic(e)))
 }
 private async retryInBackground(run:ExecutionRun):Promise<boolean>{
  const b=run.background!,mode=b.retryMode
  if(!mode||!b.review?.canResume||(b.retries??0)>=MAX_BACKGROUND_RETRIES||!this.native().resumeActivation)return false
  const parent=(this.ctx.get('agents') as {get?:(id:string)=>Agent|undefined}|undefined)?.get?.(b.sourceSessionId)
  if(!parent)return false
  this.authorize(run,parent)
  let claimed=false
  await this.save(run.id,r=>{
   const source=r.background!
   if(!source.retryMode||r.status!=='failed'||source.review?.doneAt||source.discardedAt||(source.attempt??0)!==(b.attempt??0))return
   source.retries=(source.retries??0)+1
   source.attempt=(source.attempt??0)+1
   delete r.completedAt
   r.status='queued';claimed=true
  })
  if(!claimed)return false
  const next=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===run.id)!
  const correction=mode==='manifest'?'只调用 structured_output 补交已完成结果或如实填写失败进度。':mode==='images'?'前一轮请求超过供应商请求体限制。优先看已有文字回执和文件清单，不把已知图片再次批量读入上下文。':'上一轮请求异常，核对已执行步骤后只继续缺失部分。'
  const work='继续原任务。'+correction+'不要重做已有产物或重复外部操作。'+(b.review?.lastStatement?'\n上次保留的最后说明（待核对）：'+b.review.lastStatement:'')
  try{await this.activate(next,parent,parent.session.snapshotEvents(),new AbortController().signal,work,true)}
  catch(error){await this.failed(run.id,error,next.background!.attempt)}
  return true
 }
 private reviewOnce(id:string):Promise<void>{
  const existing=this.reviews.get(id);if(existing)return existing
  const pending=this.processReview(id).catch(async error=>{
   await this.save(id,r=>{if(r.background?.review){r.background.deliveryError=diagnostic(error);r.background.review.retryAt=Date.now()+60000}})
  }).finally(()=>this.reviews.delete(id))
  this.reviews.set(id,pending);return pending
 }
 private async processReview(id:string):Promise<void>{
  const current=()=>runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id)
  let run=current(),b=run?.background
  if(!run||!b?.review||b.review.doneAt||b.discardedAt||this.closing||!backgroundSourceAllowed(runtimeSnapshot(this.store),run))return
  if(await this.retryInBackground(run))return
  if(!this.review)return
  if(!b.review.decision)await this.review(run)
  run=current();b=run?.background
  const review=b?.review,decision=review?.decision
  if(!run||!b||!review||review.doneAt||!decision||b.discardedAt||this.closing||!backgroundSourceAllowed(runtimeSnapshot(this.store),run))return
  if(decision.action==='continue'){
   const registry=this.ctx.get('agents') as {get?:(id:string)=>Agent|undefined}|undefined
   if(!registry?.get?.(b.sourceSessionId))await this.review(run)
   const parent=registry?.get?.(b.sourceSessionId)
   if(!parent||!this.native().resumeActivation)throw Error('原会话或原生续做入口暂不可用')
   let claimed=false
   await this.save(id,r=>{
    const source=r.background!
    if(!source.review?.canResume||source.review.doneAt||source.reviewResumed||source.discardedAt||source.review?.decision?.action!=='continue')return
    source.reviewResumed=true;source.attempt=(source.attempt??0)+1;r.status='queued';delete r.completedAt
    delete r.error;delete source.review;delete source.foregroundMessageId;delete source.foregroundReply;delete source.deliveryError;claimed=true
   })
   if(!claimed)return
   const next=current()!
   try{await this.activate(next,parent,parent.session.snapshotEvents(),new AbortController().signal,'原前台判断需要续做同一项任务。先核对已经完成的调用及文件，只处理剩余事项；不要重做已有产物或重复外部操作。前台要求：'+decision.text,true)}
   catch(error){await this.failed(id,error,next.background!.attempt)}
   return
  }
  if(decision.action==='deliver'){
   const files=decision.files.map(i=>{const {path,name,mediaType}=review.files[i]!;return {path,name,mediaType}})
   await this.save(id,r=>{if(r.background?.review?.decision?.action==='deliver'&&!r.background.review.doneAt&&(r.background.attempt??0)===(b.attempt??0)&&!r.background.discardedAt&&!r.background.result){r.background.result={text:decision.text,files}
      if(r.background.sourceKind==='local'){delete r.background.foregroundMessageId;delete r.background.foregroundReply}
      else r.background.foregroundReply={text:decision.text}}})
   if(current()?.background?.result)await this.deliverResult(id)
   if(!current()?.background?.deliveredAt)return
  }
  await this.save(id,r=>{if(r.background?.review&&!r.background.review.doneAt&&(r.background.attempt??0)===(b.attempt??0)){r.outputSummary=decision.text;r.background.review.doneAt=Date.now();delete r.background.deliveryError}})
 }
 private async finished(id:string,result:{stopReason:string;structured?:unknown},attempt?:number):Promise<void>{
  const run=runtimeSnapshot(this.store).executionRuns.find(r=>r.id===id);if(!run||run.status==='canceled'||this.closing||attempt!==undefined&&(run.background!.attempt??0)!==attempt)return
  if(['aborted','canceled','cancelled'].includes(result.stopReason)){
   await this.save(id,r=>{
    if(!['queued','running'].includes(r.status)||(r.background!.attempt??0)!==(attempt??0))return
    r.status='canceled';r.completedAt=Date.now();r.background!.stoppedAt=Date.now()
    delete r.background!.review;delete r.background!.retryMode
   })
   return
  }
  if(result.stopReason!=='completed')return this.failed(id,'原生后台任务结束状态：'+result.stopReason,attempt,false,result.structured)
  const value=record(result.structured)
  if(typeof value.text!=='string'||!value.text.trim())throw Error('后台结果正文不能为空')
  const text=value.text,files=[] as {path:string;name:string;mediaType:string}[]
  if(!Array.isArray(value.files)||value.files.length>8)throw Error('后台产物列表无效')
  const root=await realpath(run.background!.cwd)
  const source=run.background!.sourceCwd??(basename(dirname(root))==='.partner-background'&&basename(root)===run.id?dirname(dirname(root)):undefined)
  const sourceRoot=source?await realpath(source):undefined
  let generated:Awaited<ReturnType<typeof reviewEvidence>>|undefined
  for(const entry of value.files){
   const file=record(entry);let path=await realpath(resolve(root,requiredText(file.path,'path',4000)))
   if(!(await stat(path)).isFile())throw Error('后台产物不是文件')
   if(!path.startsWith(root+sep)){
    if(!sourceRoot||!path.startsWith(sourceRoot+sep))throw Error('后台产物不在本任务工作目录内')
    if(run.background!.audience==='member'){
     generated??=await reviewEvidence(run,await this.readChildEvents(run),'')
     const image=generated.files.find(f=>f.sourcePath===path)
     if(!image)throw Error('后台产物不在本任务工作目录内，也没有本任务的生成回执')
     files.push({path:image.path,name:image.name,mediaType:image.mediaType})
     continue
    }
    const copied=join(root,'artifacts',randomUUID()+'-'+basename(path));await mkdir(dirname(copied),{recursive:true,mode:0o700});await copyFile(path,copied,1);path=copied
   }
   files.push({path,name:requiredText(file.name,'name',240)||basename(path),mediaType:requiredText(file.mediaType,'mediaType',200)})
  }
  let committed=false
  await this.save(id,r=>{if(r.status==='canceled'||attempt!==undefined&&(r.background!.attempt??0)!==attempt)return;committed=true;r.status='completed';delete r.error;r.completedAt=Date.now();r.outputSummary=text;r.background!.result={text,files};delete r.background!.retryMode;delete r.background!.review})
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
 async recoverDeliveries():Promise<void>{
  if(this.closing||this.recovering)return
  this.recovering=true
  try{
   for(const run of runtimeSnapshot(this.store).executionRuns){
    const b=run.background
    if(!b||b.discardedAt)continue
    if(['queued','running'].includes(run.status)){
     if(!this.children.has(run.sessionId)&&!(this.ctx.get('agents') as {get?:(id:string)=>unknown}|undefined)?.get?.(run.sessionId))
      await this.failed(run.id,'服务已重启，任务保留进度，转回原前台判断',b.attempt??0,true)
    }else if(run.status==='completed'&&b.result&&!b.deliveredAt){
     await this.deliverResult(run.id)
    }else if(b.review){
     if(!b.review.doneAt&&(b.review.retryAt??0)<=Date.now())
      void this.reviewOnce(run.id).catch(error=>this.ctx.logger.warn('后台失败交接：'+diagnostic(error)))
    }else if(run.status==='failed'&&run.error?.includes('后台产物不在本任务工作目录内')&&!run.sessionCleanup?.deletedAt){
     try{await this.recoverSavedOutput(run)}catch(error){this.ctx.logger.warn('后台已保存成果恢复暂未完成：'+diagnostic(error))}
    }
   }
  }finally{this.recovering=false}
 }
 async close():Promise<void>{this.closing=true;this.detachStore();await Promise.allSettled([...this.children.values()].map(c=>c.activation?.dispose()));for(const id of this.children.keys())this.releaseChild(id);this.detachCreated();this.detachProvider?.();this.detachGuard()}
}
