import type {Context} from '@deepseek-ai/cordis'
import type {PartnerAgentRuntime} from '../agent-runtime.js'
import type {ContinuousService} from './service.js'
import {requestReservation,usageTotal} from './model.js'

export function installContinuousBudget(ctx:Context,agents:PartnerAgentRuntime,service:ContinuousService):()=>void{
 const disposers:Array<()=>void>=[]
 // Reply length follows the selected model; observation budgets stay in the observer.
 disposers.push(ctx.on('llm/stream',async function*(options,next){
  const claim=options.sessionId?agents.continuousClaim(options.sessionId):undefined
  if(!claim){yield*next();return}
  const fail=async(reason:string)=>{await service.patch(claim.owner,claim.task.id,claim.task.revision,t=>{t.phase='budget';t.reason=reason;t.budgetUntil=service.budgetResetAt(claim.owner)});throw Error(reason)}
  if(!service.current(claim.owner,claim.task))throw Error('持续任务已停止，不再生成后续消息')
  if(claim.steps>=3){await fail('本次主动接话已达到 3 次模型请求上限，不再自动重试');return}
  const id=await service.reserve(claim.owner,requestReservation(options),'chat')
  if(!id){await fail('本小时预算不足以容纳当前会话请求，保留观察，暂停主动接话');return}
  claim.steps++
  for await(const chunk of next()){
   if(chunk.type==='usage')await service.settle(claim.owner,id,usageTotal(chunk.usage))
   if(!service.current(claim.owner,claim.task))throw Error('持续任务已停止')
   yield chunk
  }
 }))
 return()=>{for(const stop of disposers.reverse())stop()}
}
