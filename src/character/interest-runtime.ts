import type {Context} from '@deepseek-ai/cordis'
import type {PartnerAgentRuntime} from '../agent-runtime.js'
import type {PartnerStore} from '../store.js'

/** No extra classifier. Bound only the new interest wake, never a user turn or ordinary idle work. */
export function installInterestLimit(ctx:Context,agents:PartnerAgentRuntime):()=>void{
 const stops:Array<()=>void>=[]
 stops.push(ctx.on('agent/request',async({agent},next)=>{const options=await next();return agents.interestClaim(agent.session.id)?{...options,maxTokens:800}:options}))
 stops.push(ctx.on('llm/stream',async function*(options,next){
  const claim=options.sessionId?agents.interestClaim(options.sessionId):undefined
  if(!claim){yield*next();return}
  if(!claim.valid){agents.stopInterest(options.sessionId!,claim.messageId);return}
  if(claim.counter.steps>=4){await agents.interestLimit(options.sessionId!,'本次兴趣续接已达到 4 次模型请求上限，不自动重试');throw Error('兴趣续接请求上限')}
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
