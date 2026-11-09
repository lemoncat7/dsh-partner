import type { PersonaDeliveryResult } from './persona-delivery.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CONVERSATION_EXPRESSION_SCHEMA, type WorkExpressionResult } from './work-expression.js'
import { hasTaskPreamble } from '../execution/task-preamble.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { assertChatImageDelivery } from './attachment-reference.js'
import { chatReplyFromEvent } from './protocol.js'

function currentInput(events:readonly SessionEvent[]):string|undefined {
  for(const e of [...events].reverse()) {
    if(e.type==='turn/start')return
    if(e.type!=='user/message')continue
    if(e.data.source.kind==='user')return e.data.id
    if(isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e))return
  }
}
/** Successful speech after the latest input permits an explicit, silent end. */
export function hasCurrentSpeech(events:readonly SessionEvent[]):boolean {
  for(const e of [...events].reverse()) {
    if(e.type==='turn/start'||e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)&&!isRequirementDeliveryReceipt(e)))return false
    if(e.type==='tool/call'&&e.data.name==='partner_work_execute')return false
    const reply=chatReplyFromEvent(e)
    if(reply?.intermediate&&reply.delivered&&reply.inputMessageId===currentInput(events))return !reply.taskPreamble
  }
  return false
}

function validateSpeechText(raw:string,expanded:boolean):void {
  if(typeof raw!=='string'||!raw.trim()||raw.length>(expanded?1200:180)||!expanded&&/[\r\n]/.test(raw))throw Error('这里只发送一条简短的聊天消息（最多 180 字，不换行）；详细内容使用最终回复或附件')
  assertChatImageDelivery(raw.trim())
}

/** Per active channel turn. Serial sends, sticky unknown failures, no background continuation. */
export class LiveSpeech {
  private pending:Promise<void>=Promise.resolve()
  private failed=false
  private count=0
  private sent=new Map<string,Promise<void>>()
  constructor(private events:()=>readonly SessionEvent[],private send:(text:string)=>Promise<void>,private active:()=>boolean){}
  say(raw:string,signal:AbortSignal,expanded=false,task=false,validate?:()=>void):Promise<void> {
    const input=currentInput(this.events())
    if(!input||!this.active())return Promise.reject(Error('只能在当前用户聊天中接话；不能用于闲时活动或内部任务'))
    try {validateSpeechText(raw,expanded)}catch(error){return Promise.reject(error)}
    const text=raw.trim()
    const key=input+'\0'+text,previous=this.sent.get(key)
    if(previous)return previous
    if(this.count>=(task?7:6))return Promise.reject(Error('本轮中途接话已达上限，请用 partner_chat_reply 结束，不继续自说自话'))
    this.count++
    const job=this.pending.then(async()=>{
      signal.throwIfAborted()
      if(this.failed||!this.active()||currentInput(this.events())!==input)throw Error('输入或发送状态已变化，旧接话未发送；先处理新消息，不重试未知发送')
      validate?.()
      await this.send(text)
    })
    this.sent.set(key,job)
    this.pending=job.catch(()=>{this.failed=true})
    return job
  }
}
export function installLiveSpeech(agent:Agent,send:(text:string)=>Promise<void>,route:()=>string|undefined,chatEnabled:()=>boolean=()=>true,short:()=>boolean=()=>true,compose?:(selection:unknown,exec:ToolRunContext,beforeTools:boolean)=>Promise<WorkExpressionResult>,voice?:(text:string,exec:ToolRunContext,beforeTools:boolean,preserveText:boolean,inlineDetails:boolean)=>Promise<PersonaDeliveryResult>):()=>void {
  const speech=new LiveSpeech(()=>agent.session.snapshotEvents(),send,()=>!!route())
  const taskSends=new Map<string,{names:Set<string>;job:Promise<void>}>()
  return agent.ctx.tools.register({
    name:'partner_chat_say',
    description:'向当前私聊发送一句按人物与关系设定写好的 text，确认送达后继续本轮。需要从资料生成发言时可选 expression（意图及真实 sourceCalls），与 text 互斥；生成失败后直接用 text，不重复交接。工具任务前设 beforeTools:true，expectedTools 填本轮准备执行的真实工具名，含必要交付；不能填 partner_tools 等目录或说话入口。确认送达后执行；同轮新增动作再次登记，程序不重复发送前置回应。尚未执行不能说已完成，叙事动作不登记工具任务。普通接话省略 beforeTools；有新话可以继续调用，发送后不重复。最后用 partner_chat_reply 收尾；已有普通接话且没有新内容可 messages:[]，只有任务前告知时仍需结果回复。语气及聊天节奏由当前人物与关系设定决定，工具不另设表达风格。',
    parameters:{type:'object',properties:{preserveText:{type:'boolean',description:'仅当前用户指定的原文，且 text 可在用户原话中核对时使用。'},expression:CONVERSATION_EXPRESSION_SCHEMA,expectedTools:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string',maxLength:100,pattern:'^[a-zA-Z0-9_.:-]+$'},description:'beforeTools=true 时必填。承诺本轮实际执行的具体工具名，含必要交付；目录查询不算执行。普通接话不填。'},text:{type:'string',minLength:1,maxLength:1200},beforeTools:{type:'boolean',description:'这句话是在告知即将实际执行的动作时设为 true；普通闲聊不设置。必须等本次发送成功再执行任务。'},inlineDetails:{type:'boolean',description:'仅用户明确要求详细内容、原文或完整任务计划时使用；普通接话不借此展开长文。'}},anyOf:[{required:['text']},{required:['expression']}],additionalProperties:false},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:(value as {actionsAdded?:boolean}).actionsAdded?'新增动作已登记，没有重复发送前置回应；继续执行新增动作，已经完成的操作不要重做。':(value as {alreadyAnnounced?:boolean}).alreadyAnnounced?'动作已告知，本次没有重复发送；继续执行任务。':'这句话已发送。继续按同一人物口吻接话或执行已告知的操作；完成后用 partner_chat_reply 结束，不重复已说内容。仅任务前告知不能代替任务最终答复。'+(typeof (value as {spokenText?:unknown}).spokenText==='string'?'\n实际发送的正文：'+(value as {spokenText:string}).spokenText:'')}],presentationMeta:(_args,value)=>value},
    presentCall:()=>({card:'generic',title:'接话'}),
    async execute(raw,exec){
      const originRouteId=route();if(!originRouteId)throw Error('当前聊天目标已失效')
      const inputMessageId=currentInput(agent.session.snapshotEvents())
      const {beforeTools,inlineDetails,expectedTools,expression}=raw as {text?:string;beforeTools?:boolean;inlineDetails?:boolean;expectedTools?:string[];expression?:unknown}
      let text=(raw as {text?:string}).text ?? ''
      if(expression!==undefined&&(raw as {text?:unknown}).text!==undefined)throw Error('expression 只提交意图，不能同时提交 text 成稿')
      let authored:WorkExpressionResult|undefined
      let voiced:PersonaDeliveryResult|undefined
      const resolveText=async()=>{
        if(expression===undefined){
          if(voice){
            voiced=await voice(text,exec,beforeTools===true,(raw as {preserveText?:boolean}).preserveText===true,inlineDetails===true)
            if(voiced.parts.length!==1||!('text'in voiced.parts[0]!))throw Error('本次接话未得到单条文字，未发送')
            text=voiced.parts[0].text;voiced.validate?.()
          }
          return
        }
        if(!compose)throw Error('当前会话未提供表达器，未发送；请直接用 text 接话')
        authored=await compose(expression,exec,beforeTools===true)
        if(authored.parts.length!==1||!('text' in authored.parts[0]!))throw Error('表达器未生成单条文字，未发送；请直接用 text 接话')
        text=authored.parts[0].text
        authored.validate?.()
      }
      exec.signal.throwIfAborted()
      if(!beforeTools&&!chatEnabled())throw Error('连续接话未开启；任务动作告知使用 beforeTools:true，普通内容用最终回复')
      if(beforeTools&&(!Array.isArray(expectedTools)||!expectedTools.length||expectedTools.length>8||expectedTools.some(n=>typeof n!=='string'||n.length>100||! /^[a-zA-Z0-9_.:-]+$/.test(n)||['partner_tools','partner_chat_say','partner_chat_reply','partner_chat_progress'].includes(n))))throw Error('动作告知尚未发送：beforeTools=true 时用 expectedTools 列出准备实际调用的具体工具名；生图并发送填实际生图工具名和 partner_send_attachment，不填 partner_tools。')
      if(beforeTools&&inputMessageId){
        // Validate exact registered names before speaking or recording obligations. No guessed aliases.
        const unknown=expectedTools!.filter(name=>!agent.ctx.tools.get(name,agent))
        if(unknown.length)throw Error('动作告知尚未发送或登记：工具名未在当前上下文注册：'+unknown.join('、')+'。先通过 partner_tools list/describe 核实具体名称，再重新告知；不要猜测别名，也不要把本检查发给用户。')
        const previous=taskSends.get(inputMessageId)
        if(previous)await previous.job
        exec.signal.throwIfAborted()
        if(currentInput(agent.session.snapshotEvents())!==inputMessageId||route()!==originRouteId)throw Error('当前输入或渠道已变化，旧动作未登记')
        const known=new Set(taskSends.get(inputMessageId)?.names??[])
        for(const event of agent.session.snapshotEvents()){
          const receipt=chatReplyFromEvent(event)
          if(receipt?.delivered&&receipt.taskPreamble&&receipt.inputMessageId===inputMessageId)for(const name of receipt.expectedTools??[])known.add(name)
        }
        const added=[...new Set(expectedTools!)].filter(name=>!known.has(name))
        if(!added.length)return {alreadyAnnounced:true}
        if(previous||hasTaskPreamble(agent.session.snapshotEvents())){
          taskSends.set(inputMessageId,{names:new Set([...known,...added]),job:Promise.resolve()})
          return {kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',intermediate:true,taskPreamble:true,expectedTools:added,inputMessageId,originRouteId,alreadyAnnounced:true,actionsAdded:true}
        }
        await resolveText()
        // Local validation has no delivery side effect; do not cache its rejection as a send.
        validateSpeechText(text,!short()||inlineDetails===true)
        const job=speech.say(text,exec.signal,!short()||inlineDetails===true,true,voiced?.validate??authored?.validate)
        taskSends.set(inputMessageId,{names:new Set(added),job});await job
      }else {
        await resolveText()
        await speech.say(text,exec.signal,inlineDetails===true,false,voiced?.validate??authored?.validate)
      }
      return {kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',intermediate:true,...(beforeTools?{taskPreamble:true,expectedTools:[...expectedTools!]}:{}),inputMessageId,spokenText:text.trim(),originRouteId,...(authored?.audit?{workExpression:authored.audit}:{}),...(voiced?.audit?{personaDelivery:voiced.audit}:{})}
    },
  })
}
