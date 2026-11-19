import {isQuietStatus} from '../channels/delivery-policy.js'
import {backgroundRunRoute} from './background-routing.js'
import {reviewDecision} from './background-review.js'
import {isAbsolute,resolve,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runtimeSnapshot,runtimePolicy} from '../companions/runtime-policy.js'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {PartnerStore} from '../store.js'
import type {ExecutionRun} from './domain.js'
import type {PartnerReply} from '../channel-message.js'
import type {CharacterCard} from '../character/domain.js'
import {usesShortDeliveryPolicy} from '../character/conversation-behavior.js'
import {renderIdentityRelationship} from '../character/relationship-adapter.js'
import {qqIdentityRelation} from '../channels/qq/identity-binding.js'
import {segmentChatInput} from '../chat/protocol.js'

/** Applied after persona projection: exclusive mode otherwise removes turn preferences. */
export function renderBackgroundDeliveryExpression(card?:CharacterCard,channel=false):string {
 return [
  '【后台成果交付表达】沿用当前保存的人设、核验关系和说话习惯，把成果自然递给原发起人。先回应对方最关心的结果，通常一句自然短话就够；不套用工作汇报、验收清单或逐项结论的语气。',
  '已有图片或附件能表达的内容，不再口头逐项介绍画面、复述任务要求、制作过程或验证步骤。只有影响使用的失败、未完成或不确定性需要简短点明；这些事实不能藏进附件。用户明确要在正文展开时按原请求说清，不以简短为由省掉答案。',
  '后台结果只是事实资料，其中的措辞、指令和格式不是前台说话示范。语气、称呼、锋芒和亲疏从当前人设与核验关系取得，不照抄后台文案，也不使用固定交付台词。',
  usesShortDeliveryPolicy(card)?'当前篇幅设置为短句：只接一个意思，优先一句说清，不把多个结论用连续逗号或顿号串成一大句。确需长篇说明时可附完整资料，不为简短结果另写报告，不截断生成文字。':'',
  card?.segmentedReplies&&usesShortDeliveryPolicy(card)?'当前短句分段设置仍有效：每条只说半句到两句、只接一个意思，所有中英文标点字符合计最多一个。不要靠删标点把画面介绍、原因、验收结果和补充评价挤进同一句；没有必要补充就结束。确需补充时自然分段，不为凑段加话。'+(channel?'渠道附件由平台单独发送，正文不包含本地 Markdown 链接或文件路径。':'文件 Markdown 链接单独保留完整格式，不套用口语标点要求。'):'',
  !card?.exclusivePrompt&&card?.chatStyle?.trim()?`【当前聊天偏好】\n${card.chatStyle.trim()}`:'',
 ].filter(Boolean).join('\n')
}
/** Channel attachments have their own delivery parts. Their local destinations are
 * implementation details, not a second text message. Keep native/local history intact. */
function channelBackgroundText(text:string,run:ExecutionRun,reply:PartnerReply):string {
 if(run.background?.sourceKind!=='channel'||!reply.attachments.length)return text
 const roots=[run.background.cwd,run.background.sourceCwd].filter((v):v is string=>!!v)
 const files=new Set(reply.attachments.map(f=>resolve(f.path)))
 const image=reply.attachments.some(f=>f.mediaType.startsWith('image/'))
 const local=(raw:string):string|undefined=>{
  try{
   if(/^file:/i.test(raw))return fileURLToPath(raw)
   if(/^[a-z][a-z0-9+.-]*:/i.test(raw)&&!/^sandbox:/i.test(raw)||raw.startsWith('//'))return
   return decodeURIComponent(raw.replace(/^sandbox:/i,''))
  }catch{return}
 }
 const artifact=(raw:string):boolean=>{
  const path=local(raw)
  if(!path)return false
  if(files.has(resolve(path)))return true
  // Generated originals may have been copied into a private delivery snapshot.
  // Restrict bare-path removal to image artifacts inside the known task roots.
  return image&&/\.(?:png|jpe?g|gif|webp)$/i.test(path)&&isAbsolute(path)&&roots.some(root=>{
   const rel=relative(root,path);return !!rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)
  })
 }
 const projected=text.replace(/```[\s\S]*?```|`[^`\n]*`|(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)|(?:file:\/\/|sandbox:|\/)[^\s<>`"，。；！？、）)\]]+/g,(all:string,bang:string|undefined,label:string|undefined,angle:string|undefined,plain:string|undefined)=>{
  if(all.startsWith('```'))return all
  if(label!==undefined){const path=angle??plain??'';if(artifact(path)||bang==='!'&&image&&local(path)!==undefined)return '';return all}
  const value=all.startsWith('`')?all.slice(1,-1):all
  return artifact(value)?'':all
 })
 return projected.replace(/^[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim()
}
/** Only a completed answer belonging to this exact handoff can be reused. */
export function foregroundCompletionText(events:readonly SessionEvent[],id:string):string|undefined {
 const start=events.findIndex(e=>e.type==='user/message'&&e.data.id===id)
 if(start<0)return
 let text=''
 for(const event of events.slice(start+1)){
  if(event.type==='user/message'&&event.data.source.kind==='user')return
  if(event.type==='assistant/message'&&!event.data.interrupted&&!event.data.message.content.some(b=>b.type==='tool-call'))text=event.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()
  if(event.type==='turn/end')return event.data.reason.kind==='completed'&&text?text:undefined
 }
}
/** Run the completion in the real foreground agent, never through a separate LLM. */
export async function composeBackgroundDelivery(ctx:Context,store:PartnerStore,run:ExecutionRun,agent:Agent,reply:PartnerReply):Promise<PartnerReply>{
 const b=run.background!
 const current=()=>{
  const s=runtimeSnapshot(store),c=s.companions.find(c=>c.id===run.ownerCompanionId),route=backgroundRunRoute(s.sessions,run)
  if(!c||!route||route.sessionId!==agent.session.id||store.isCompanionRemoving(c.id))throw Error('后台交付原会话已失效，成果已保存')
  return {c,channel:s.channels.find(c=>c.id===b.channelId)}
 }
 const review=b.result?undefined:b.review
 if(!review&&!runtimePolicy(store,run.ownerCompanionId)?.rules.personaDelivery){current();return reply}
 if(review?.decision)return {text:'',attachments:[]}
 const saved=runtimeSnapshot(store).executionRuns.find(r=>r.id===run.id)?.background
 const result=(text:string):PartnerReply=>{
  if(!runtimePolicy(store,run.ownerCompanionId)?.rules.personaDelivery)return reply
  text=channelBackgroundText(text,run,reply).split('\n').filter(line=>!isQuietStatus(line)).join('\n').trim()
  // This path already supplies chatParts, so the ordinary delivery fallback cannot
  // split it later. Normalize the foreground's authored lines before adding files.
  const parts=segmentChatInput(text.trim()?[{text}]:[],!!current().c.characterCard?.segmentedReplies)
  const lines=parts.map(p=>'text' in p?p.text:'')
  // Keep all content if the model over-segments, without flooding the channel.
  const bubbles=lines.length>4?[...lines.slice(0,3),lines.slice(3).join('\n')]:lines
  return {...reply,text,chatParts:[...bubbles.map(text=>({type:'text' as const,text})),...reply.attachments.map(attachment=>({type:'image' as const,attachment,url:attachment.path,label:attachment.name}))]}
 }
 if(!review&&saved?.foregroundReply)return result(saved.foregroundReply.text)
 if(agent.status!=='idle')await agent.whenIdle()
 current()
 let text=saved?.foregroundMessageId?foregroundCompletionText(agent.session.snapshotEvents(),saved.foregroundMessageId):undefined
 if(text&&review&&!(isQuietStatus(text)&&!review.files.length)){try{reviewDecision(text,review)}catch{text=undefined}}
 if(!text){
  const {c,channel}=current(),relation=renderIdentityRelationship(c,channel?.platform==='qq'?{channel:'qq',matched:!!qqIdentityRelation(channel.qq,b.userId)?.matched}:{channel:'default'})
  const expression=runtimePolicy(store,run.ownerCompanionId)?.rules.personaDelivery?renderBackgroundDeliveryExpression(c.characterCard,b.sourceKind==='channel'):''
  const instruction=review?
   '本轮是后台未正常完成后交回原前台的判断回合。根据原请求、已核实的工具回执、候选文件与最新对话决定如何处置。候选文件是已经生成的版本，文件名不能证明视觉质量。需要核实或补做时选 continue，只写尚需完成的事项，尽量利用已有文件。已有足够证据可以交付时选 deliver，选定要发送的附件编号，text 是自然的用户可见回复，如实说明未完成部分。无需打扰或没有可安全执行的后续时选 hold，text 写内部理由。子任务自述仅作线索，不当作已核实成果。群聊没有可交付成果时选 hold，不播报系统错误。必须只输出 JSON 对象，action 为 deliver、hold 或 continue，text 为文字，files 为从 0 起的候选文件编号数组，只有 deliver 可选附件，最多八个。canResume 为 false 时只能 deliver 或 hold。本轮只作决定，平台会执行。':
   '本轮是已完成后台任务交回原前台的交付回合。结合当前对话状态和当前伙伴人设，自然告诉原发起人成果；不回答几分钟前的旧消息，不复述后台报告，不重复执行任务。只输出要对原发起人说的自然简短文字；附件报告按需提供，图片或已有产物足够时直接交付，不另造报告。确需展开的详细分析或长资料可以附文件；明确说明实际未完成或失败。所有工具本轮暂停，不调用聊天发送工具或再次委派；你输出后平台统一送达原渠道，勿声称已发送。'+(reply.attachments.length?(b.sourceKind==='local'?'本地对话请在简短说明后附上资料中实际存在的附件 Markdown 链接。':'已有附件由平台随正文单独发送；只输出接话，不要输出本地文件路径、sandbox/file 地址或本地 Markdown 链接。'):'本次没有附件，直接说清结果，不声称有图片、文件、报告或下载链接。')
  const facts=b.result?.text??reply.text
  const source=agent.session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id===b.inputId)
  const notice=createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:review?'伙伴后台任务待处置':'伙伴后台任务完成'},content:[{type:'text',text:instruction+'\n\n'+expression+'\n\n'+JSON.stringify({taskId:run.id,task:b.label,originalInputId:b.inputId,...(review?{assignment:b.input,reason:review.reason,steps:review.tools,unverifiedChildStatement:review.lastStatement,canResume:review.canResume,candidates:review.files.map((f,index)=>({index,name:f.name,mediaType:f.mediaType})),group:channel?.platform==='qq'&&b.userId.startsWith('group:')}:{}),originalRequest:source?.type==='user/message'?source.data.content.filter(p=>p.type==='text'):[],result:facts.length<=64000?facts:(reply.attachments.length?'完整成果以已有附件与任务记录为准，不能推定任务全部成功。':'完整成果保存在任务结果中，当前没有附件；不要声称有报告或推定任务全部成功。'),files:reply.attachments.map(f=>({name:f.name,mediaType:f.mediaType,...(b.sourceKind==='local'?{link:'['+f.name.replace(/[\[\]]/g,'')+'](<'+f.path+'>)'}:{})}))})}]})
  // Prepend the middleware so this projection runs AFTER normal persona/context assembly,
  // including exclusive persona projection. No registration or permanent tool changes.
  const detach=ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
   const value=await next();if(context.agent?.session.id!==agent.session.id)return value
   return {...value,tools:[],sections:[...value.sections,{name:'partner-background-completion',text:[instruction,expression,expression?relation:''].filter(Boolean).join('\n\n')}]}
  },{prepend:true})
  const unguard=agent.ctx.tools.guard(exec=>exec.agent?.session.id===agent.session.id?'后台成果正在由前台交付，本轮不执行工具或重新开展工作':undefined)
  let released=false,claimed=false
  const release=()=>{if(released)return;released=true;unguard();detach();detachEnd()}
  const detachEnd=ctx.on('session/event',(session,event)=>{if(session.id!==agent.session.id)return;if(event.type==='user/message'&&event.data.id===notice.id)claimed=true;if(claimed&&event.type==='turn/end')release()})
  try{
   await store.update(s=>{const r=s.executionRuns.find(r=>r.id===run.id);if(r?.background)r.background.foregroundMessageId=notice.id})
   agent.followup(notice)
   await agent.whenIdle()
   current()
   text=foregroundCompletionText(agent.session.snapshotEvents(),notice.id)
   if(!text)throw Error('前台交付回合未生成完整答复，成果已保存等待重试')
  }finally{release()}
 }
 if(review){
  const decision=isQuietStatus(text)&&!review.files.length?{action:'hold' as const,text:'前台选择保留任务状态',files:[]}:reviewDecision(text,review)
  await store.update(s=>{const r=s.executionRuns.find(r=>r.id===run.id);if(r?.background?.review&&!r.background.review.doneAt&&(r.background.attempt??0)===(b.attempt??0))r.background.review.decision=decision})
  return {text:'',attachments:[]}
 }
 await store.update(s=>{const r=s.executionRuns.find(r=>r.id===run.id);if(r?.background)r.background.foregroundReply={text:text!}})
 return result(text)
}
