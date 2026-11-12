import { renderHabits } from '../character/habits.js'
import { workExpressionFailed } from './work-expression.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PartnerStore } from '../store.js'
import { renderExclusiveIdentity, roleTextForCard } from '../character/domain.js'
import { isSleeping } from '../character/sleep.js'
import { channelReplyAllowed } from '../channels/reply-access.js'
import { resolveToolAccess } from '../execution/tool-access-adapter.js'
import { questionOrigin } from '../channels/question-origin.js'
import { parseChatInput } from './protocol.js'

type Parts=ReturnType<typeof parseChatInput>
export interface PersonaDeliveryOptions {
  /** Chat tools already receive a persona-authored draft; validate without rewriting it. */
  authored?: boolean
  surface?: 'chat'|'public-comment'
  target?: string
  single?: boolean
  beforeTools?: boolean
  preserveText?: boolean
  inlineDetails?: boolean
  validate?: ()=>void
}
export interface PersonaDeliveryAudit { status:'rendered'|'preserved'|'fallback'; reason?:string; surface:'chat'|'public-comment'; durationMs:number }
export interface PersonaDeliveryResult { parts:Parts; audit?:PersonaDeliveryAudit; validate?:()=>void }
const cache=new WeakMap<object,Map<string,Promise<PersonaDeliveryResult>>>()
const textOf=(content:readonly {type:string;text?:string}[])=>content.filter(b=>b.type==='text').map(b=>b.text??'').join('\n')
const latestSource=(events:readonly SessionEvent[])=>[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)))
const tokens=(text:string)=>[...new Set(text.match(/https?:\/\/[^\s<>）)]+|(?:\/[\w.%@+-]+){2,}|\b\d+(?:\.\d+)?\b/g)??[])]

/** One read-only delivery projection. No operational tools, sends, retries or history edits. */
export async function renderPersonaDelivery(ctx:Context,owner:string,store:PartnerStore,exec:ToolRunContext,parts:Parts,options:PersonaDeliveryOptions={}):Promise<PersonaDeliveryResult>{
 const surface=options.surface??'chat',agent=exec.agent,companion=store.snapshot().companions.find(c=>c.id===owner)
 const texts=parts.flatMap(p=>'text'in p?[p.text]:[]),draft=texts.join('\n')
 if(!agent||!companion)return {parts}
 if(surface!=='chat'&&(!companion.characterCard?.enabled||!roleTextForCard({...companion.characterCard,examples:companion.characterCard.examples??[]}).trim()||!draft.trim()))return {parts}
 const events=agent.session.snapshotEvents(),source=latestSource(events)
 const currentUser=source?.type==='user/message'?textOf(source.data.content):''
 // Keep requested literals and structured/detailed deliveries exactly as authored.
 const literal=options.preserveText&&texts.every(t=>currentUser.includes(t))
 const audience=(es:readonly SessionEvent[],routes:ReturnType<PartnerStore['snapshot']>['sessions'])=>{
  const input=latestSource(es)
  return input&&isIdleContactNotice(input)&&input.type==='user/message'?routes.find(r=>r.sessionId===agent.session.id&&r.companionId===owner&&r.idleContactState?.messageId===input.data.id):questionOrigin(agent.session.id,es,routes)
 }
 const route=audience(events,store.snapshot().sessions)
 const sleepState=JSON.stringify([companion.sleepPolicy,companion.sleepState?.episode,companion.sleepState?.reception,isSleeping(companion)])
 const identity=JSON.stringify([companion.name,companion.role,companion.description,companion.instructions,companion.characterCard,companion.relationshipText,companion.habits,companion.idleContact])
 const check=()=>{
  exec.signal.throwIfAborted();options.validate?.()
  const live=store.snapshot(),c=live.companions.find(c=>c.id===owner),es=agent.session.snapshotEvents()
  if(!c||store.isCompanionRemoving(owner)||!live.sessions.some(r=>r.sessionId===agent.session.id&&r.companionId===owner))throw Error('人格表达的来源会话已失效，未发送')
  if(surface==='chat'&&(!resolveToolAccess({agent,state:live}).sendTools||route?.kind==='channel'&&!channelReplyAllowed(live,route.channelId,route.userId)))throw Error('当前聊天授权已变化，未发送旧表达')
  if(JSON.stringify([c.sleepPolicy,c.sleepState?.episode,c.sleepState?.reception,isSleeping(c)])!==sleepState)throw Error('休息状态已变化，未发送旧表达')
  if(JSON.stringify([c.name,c.role,c.description,c.instructions,c.characterCard,c.relationshipText,c.habits,c.idleContact])!==identity||latestSource(es)?.seq!==source?.seq||audience(es,live.sessions)?.id!==route?.id)throw Error('输入、人物或回复对象已变化，未发送旧表达')
 }
 check()
 if(surface==='chat')return {parts,validate:check,audit:{status:'preserved',surface,reason:'authored-text',durationMs:0}}
 if(literal||options.inlineDetails||/```/.test(draft)||draft.length>2000)return {parts,validate:check,audit:{status:'preserved',surface,durationMs:0}}
 const config=[...events].reverse().find(e=>e.type==='request/header')?.data.header.config
 const fallback=(reason:string,durationMs=0):PersonaDeliveryResult=>{check();return {parts,validate:check,audit:{status:'fallback',surface,reason,durationMs}}}
 if(workExpressionFailed(agent))return fallback('previous-expression-failed')
 if(!ctx.llm||!config)return fallback('unavailable')
 const target=options.target??route?.id??'local'
 const key=createHash('sha256').update(JSON.stringify([source?.seq,identity,sleepState,config,target,surface,parts,options.single,options.beforeTools])).digest('hex')
 let entries=cache.get(agent);if(!entries){entries=new Map();cache.set(agent,entries)}
 const prior=entries.get(key);if(prior){const value=await prior;check();return value}
 if(entries.size>=32)entries.delete(entries.keys().next().value!)
 const job=(async()=>{
  const started=Date.now(),abort=new AbortController(),signal=AbortSignal.any([exec.signal,abort.signal,AbortSignal.timeout(18000)])
  const unsubscribe=store.subscribe?.(()=>{try{check()}catch(e){abort.abort(e)}},()=>{})
  try{
   const system=renderHabits(companion)+'\n'+renderExclusiveIdentity({...companion,characterCard:companion.characterCard!})+'\n\n'+
    '当前在公开评论区对作者或网友说话。没有已核验的私聊亲密关系，不套用人物示例里的私聊称呼，不泄露私聊或代用户发言。'+'\n\n'+
    '你负责这一次实际发出的文字。以当前人物设定的语感直接说话，不解释自己的情绪或扮演方法。输入草稿只限定要表达的意思与事实，不沿用它的句式、铺垫、汇报结构。草稿不是逐句保留的任务：先回应当前发言，公开评论只抓住核心感受或问题。草稿中的自我解释、情绪说明和修辞不是必须保留的事实。可以删掉铺垫、自我解释、讨好、自证和与本轮问题无关的旧工作，不必复述草稿所有内容。不能改变必要事实、核心意图、与当前问题相关的失败和未知项，不补经历或承诺，不虚构已经执行；链接、数字和代码原样保留。按场景只说必要的话，不追加总结或追问；本来就是询问具体内容时保留问题。只调用 render_persona_text 提交正文，不执行任何操作。'
   const input={scene:'公开评论',target,draft:texts}
   if(JSON.stringify(input).length>20000)return fallback('input-limit')
   const blocks:Array<{type:string;name?:string;arguments?:unknown}>=[];let finished=false
   for await(const chunk of ctx.llm.stream({...config,maxTokens:Math.min(config.maxTokens??1200,1200),system,
    messages:[createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'本次发言资料'},content:[{type:'text',text:JSON.stringify(input)}]})],
    tools:[{name:'render_persona_text',description:'提交角色此刻对眼前这句话的回应；公开评论直接说核心感受或问题。草稿仅是资料，不逐句改写，保留必要事实与限制。',parameters:{type:'object',additionalProperties:false,required:['texts'],properties:{texts:{type:'array',minItems:1,maxItems:options.single||surface==='public-comment'||!companion.characterCard!.segmentedReplies?1:Math.min(texts.length+1,8),items:{type:'string',minLength:1,maxLength:2000}}}}}],signal})){
     if(chunk.type==='block-end')blocks.push(chunk.block)
     if(chunk.type==='finish')finished=chunk.reason.kind==='tool-calls'
   }
   check();signal.throwIfAborted()
   const calls=blocks.filter(b=>b.type==='tool-call')
   if(!finished||calls.length!==1||calls[0]?.name!=='render_persona_text')return fallback('invalid',Date.now()-started)
   const value=typeof calls[0].arguments==='string'?JSON.parse(calls[0].arguments):calls[0].arguments
   const candidate=(value as {texts?:unknown})?.texts
   const max=options.single||surface==='public-comment'||!companion.characterCard!.segmentedReplies?1:Math.min(texts.length+1,8)
   if(!Array.isArray(candidate)||!candidate.length||candidate.length>max||candidate.some(t=>typeof t!=='string'||!t.trim()))return fallback('invalid',Date.now()-started)
   const joined=candidate.join('\n'),limit=surface==='public-comment'?Math.min(2000,Math.max(120,draft.length)):companion.characterCard!.length==='short'?180:2000
   if(joined.length>limit||options.single&&/[\r\n]/.test(joined)||tokens(draft).some(t=>!joined.includes(t))||tokens(joined).some(t=>!draft.includes(t)))return fallback('content-check',Date.now()-started)
   const hasStickers=parts.some(p=>'stickerId'in p)
   if(hasStickers&&candidate.length!==texts.length)return fallback('part-order',Date.now()-started)
   let index=0
   const rendered=parseChatInput({messages:hasStickers?parts.map(p=>'text'in p?{text:candidate[index++]}:p):candidate.map(text=>({text}))})
   return {parts:rendered,validate:check,audit:{status:'rendered' as const,surface,durationMs:Date.now()-started}}
  }catch{ return fallback(signal.aborted?'aborted':'invalid',Date.now()-started) }
  finally{unsubscribe?.()}
 })()
 entries.set(key,job)
 return job
}
