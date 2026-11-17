import {recoverReplyTokenLimit} from '../execution/request-token-recovery.js'
import type {Context} from '@deepseek-ai/cordis'
import type {PartnerAgentRuntime} from '../agent-runtime.js'
import type {PartnerStore} from '../store.js'

/** No extra classifier. Validate only the current interest wake; never impose a request-count ceiling. */
export function installInterestLimit(ctx:Context,agents:PartnerAgentRuntime):()=>void{
 const stops:Array<()=>void>=[]
 // The host persists agent/request controls. Never use them to shorten a reply.
 const checked=new WeakSet<object>()
 stops.push(ctx.on('agent/request',async({agent},next)=>{
  const options=await next();if(!agents.runtimePolicyForSession?.(agent.session.id)?.roleChat||checked.has(agent))return options
  checked.add(agent)
  if(options.maxTokens!==700&&options.maxTokens!==800)return options
  return recoverReplyTokenLimit(options,agent.session.snapshotEvents?.()??[])
 }))
 stops.push(ctx.on('llm/stream',async function*(options,next){
  const claim=options.sessionId?agents.interestClaim(options.sessionId):undefined
  if(!claim){yield*next();return}
  if(!claim.valid){agents.stopInterest(options.sessionId!,claim.messageId);return}
  claim.counter.steps++
  for await(const chunk of next()){
   const current=agents.interestClaim(options.sessionId!)
   if(!current?.valid||current.messageId!==claim.messageId){agents.stopInterest(options.sessionId!,claim.messageId);return}
   yield chunk
  }
 }))
 return()=>{for(const stop of stops.reverse())stop()}
}
export async function recoverInterest(store:PartnerStore):Promise<void>{
 const affected=store.snapshot().companions.some(c=>c.activityPlan?.trigger==='interest'&&c.activityPlan.status!=='cancelled')||store.snapshot().sessions.some(r=>r.idleContactState?.planSnapshot?.trigger==='interest'&&!r.idleContactState.cancelled)
 if(!affected)return
 await store.update(s=>{for(const c of s.companions)if(c.activityPlan?.trigger==='interest'){c.activityPlan.status='cancelled';c.activityPlan.result='服务恢复后不补跑上次兴趣机会'};for(const r of s.sessions)if(r.idleContactState?.planSnapshot?.trigger==='interest')r.idleContactState.cancelled=true})
}
