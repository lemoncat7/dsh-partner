import type { DirectMessage } from '../direct/transport.js'
import { isAttentionCall, isClearScene, recognizedRecipient, type AttentionPrediction } from './attention-classifier.js'

export interface ReplyScore { reply:boolean; score:number; probability:number; reasons:string[]; followupRequest?:boolean; route:'direct'|'continuation'|'semantic'|'fallback'|'other'|'closing'|'opportunity' }
interface ReplyEvidence {at:number;text:string;input?:string}
export interface ReplyScoreContext { name:string; recent?:ReplyEvidence; now:number; seed:string; semantic?:AttentionPrediction; quickContinuation?:boolean; attachmentFollowup?:boolean; latestReplyToSpeaker?:boolean; latestReplyInRoom?:boolean; singleParticipant?:boolean; otherConversation?:boolean; quietRecent?:ReplyEvidence; groupRecent?:ReplyEvidence }
const normalized=(text:string)=>text.slice(0,1200).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'').slice(0,160)
export function topicSimilarity(left:string,right:string):number {
 const grams=(text:string)=>{const chars=Array.from(normalized(text)),out=new Set<string>();for(let i=1;i<chars.length;i++)out.add(chars[i-1]!+chars[i]!);return out}
 const a=grams(left),b=grams(right);if(!a.size||!b.size)return 0
 let common=0;for(const gram of a)if(b.has(gram))common++
 return 2*common/(a.size+b.size)
}
export const CONVERSATION_WINDOW_MS=5*60_000
export const GROUP_CONVERSATION_WINDOW_MS=3*60_000
export function topicContinues(text:string,context:ReplyScoreContext):boolean {
 const anchor=context.groupRecent
 if(!anchor||context.now-anchor.at<0||context.now-anchor.at>=GROUP_CONVERSATION_WINDOW_MS)return false
 const scene=context.semantic?.scene
 const freshTopic=scene?.label==='topic'&&isClearScene(scene)
 return (context.semantic?.replySimilarity??0)>=(freshTopic ? .6 : .4)
  || Math.max(topicSimilarity(text,anchor.text),topicSimilarity(text,anchor.input??''))>=.24
  || !freshTopic&&context.semantic?.replySimilarity===undefined&&(context.semantic?.contextSimilarity??0)>=.55
}
export function activeConversation(context:ReplyScoreContext):boolean {
 const age=context.recent?context.now-context.recent.at:Infinity
 return age>=0&&age<CONVERSATION_WINDOW_MS
}
export function conversationEnded(text:string):boolean {
 return /(?:别再?回复|不要(?:再|继续)?回复|不用(?:再)?回[复答]?|不用回答|先不聊|不聊了|暂停聊天|结束这个话题|让我安静|stop (?:talking|replying)|no reply (?:needed|required)|leave me alone)/iu.test(text)
}
function directAddress(text:string,name:string):boolean {
 if(!name||name.length<2||!text.startsWith(name))return false
 const tail=text.slice(name.length)
 return !tail||/^[\s\p{P}]/u.test(tail)||/^(?:你|人呢|在吗|在不在|出来|来一下|帮我|帮忙|能不能|可以|会不会)/u.test(tail)
}
/** A mention at the start identifies a recipient; an embedded mention may be the subject.
 * Older/unstructured events remain conservative rather than guessing a missing position. */
export function mentionsOtherRecipient(event:DirectMessage):boolean {
 const group=event.qqGroup
 if(!group?.otherMention)return false
 const offset=group.otherMentionOffsets?.[0]
 return offset===undefined||!event.text.slice(0,offset).replace(/[\s\p{P}\p{S}]/gu,'')
}
/** Preserve structured mention positions only for local intent recognition, never invent names. */
export function attentionMessageText(event:DirectMessage):string {
 let text=event.text
 for(const offset of [...(event.qqGroup?.otherMentionOffsets??[])].reverse())text=text.slice(0,offset)+' @其他成员 '+text.slice(offset)
 return text
}
/** A short repeated subject plus a question marker can refer to an adjacent utterance. */
export function clarificationSubject(text:string):string|undefined {
 const value=text.normalize('NFKC').toLocaleLowerCase().trim()
 if(Array.from(value).length>18)return
 const question=/^([\p{L}\p{N}]+?)(?:啥|什么(?:意思)?|是啥|怎么说|是什么意思|呢|吗|么|嘛)[\s?？!！。]*$/u.exec(value)?.[1]
 if(question)return question
 return /^([\p{L}\p{N}]{1,12})[?？]+$/u.exec(value)?.[1]
}
/** Short requests often omit the action's object when the preceding turn supplied it. */
function asksForFollowup(text:string):boolean {
 const request=/^(?:(?:那(?:么|就)?|所以|这样的话)[\s，,]*)?你(?!们)\s*(.+)$/u.exec(text.trim())?.[1]
 if(!request||/^(?:也?不用|不必|别|不要|算了)/u.test(request))return false
 return /^(?:能不能|可不可以|请|麻烦|帮我|给我|再来).+/u.test(request)
  || /(?:[^是了过]一(?:个|下|遍|次|句|条)|试试(?:看)?|给我(?:看看|听听)|什么意思|怎么回事|行不行|行吗|可以吗|[？?])[啊呀吧呗嘛\s。！!？?~～]*$/u.test(request)
}
/** Strong routing facts run before semantics; recent conversation is context, not a promise to answer every line. */
export function routeGroupReply(event:DirectMessage,context:ReplyScoreContext):ReplyScore|undefined {
 const text=event.text.trim(),group=event.qqGroup
 const decide=(reply:boolean,route:ReplyScore['route'],reason:string):ReplyScore=>({reply,route,score:reply?100:0,probability:reply?1:0,reasons:[reason]})
 if(conversationEnded(text))return decide(false,'closing','用户明确结束或暂停接话')
 if(group?.mentioned)return decide(true,'direct','明确 @ 伙伴')
 if(group?.replyTo==='self')return decide(true,'direct','引用伙伴已确认发送的消息')
 if(mentionsOtherRecipient(event)||group?.replyTo==='other')return decide(false,'other','消息明确发给其他成员')
 if(group?.hasReply)return decide(false,'other','引用对象未确认，先旁听')
 const textMention=/^[@＠]\s*/u.exec(text)
 if(directAddress(textMention?text.slice(textMention[0].length):text,context.name.trim()))
  return decide(true,'direct',textMention?'文字 @ 指向伙伴':'直接叫到角色名字')
 if(group?.otherMention)return undefined // Ambiguous recipient: require the local model, never a recency/public-question shortcut.
 if(!event.media?.length&&/^(?:哈{2,}[\s，,]*)?(?:嗯{1,3}|好|好的|收到|ok|知道了|了解|谢谢|谢了|晚安|拜拜|下次聊|先走了|对[啊呀的]?|是[啊呀的]?|确实|我也觉得|哈{2,})[\s。.!！~～]*$/iu.test(text))return decide(false,'closing','确认或收尾语，无需逐条回应')
 if(!event.media?.length&&/^[\s\p{P}\p{S}]+$/u.test(text)&&!activeConversation(context))return decide(false,'fallback','孤立标点或符号，没有明确对话对象')
 if(/(?:大家|各位|你们).{0,16}(?:觉得|怎么看|谁会|能不能|来看看|帮忙)|(?:有没有人|有人(?:知道|会|能|懂))/u.test(text))return decide(true,'opportunity','面向全群的询问或交流邀请，进入接话判断')
 if(!text&&event.media?.length){
  if(context.attachmentFollowup)return decide(true,'continuation','附件紧邻发给同一群友的已送达回复，由模型决定是否接话')
  if(context.quickContinuation&&activeConversation(context))return decide(true,'continuation','同一成员紧接着补发了附件')
  // The local attention model reads text only. An image is itself a share,
  // so let the conversation model see it before deciding to speak or stay quiet.
  if(event.media.some(media=>media.kind==='image'))return decide(true,'opportunity','收到图片分享，结合图片与群聊上下文决定是否接话')
 }
 return undefined
}
export function scoreGroupReply(event:DirectMessage,context:ReplyScoreContext):ReplyScore {
 const routed=routeGroupReply(event,context);if(routed)return routed
 const text=event.text.trim(),semantic=context.semantic
 const decide=(reply:boolean,route:ReplyScore['route'],reason:string,score=reply?100:0):ReplyScore=>({reply,route,score,probability:reply?1:0,reasons:[reason]})
 const opportunity=(probability:number,score:number,reason:string):ReplyScore=>{
  let hash=2166136261;for(const char of context.seed)hash=Math.imul(hash^char.charCodeAt(0),16777619)
  const reply=(hash>>>0)/4294967296<probability
  return {reply,route:'opportunity',score,probability,reasons:[reason+(reply?'':'，本次旁听')]}
 }
 const recipient=recognizedRecipient(semantic?.recipient)
 if(semantic?.learnedCall)return decide(true,'semantic',semantic.learnedCall==='relationship'?'关系设定中的已训练称呼，确认呼唤伙伴':'角色设定中的已训练称呼，确认呼唤伙伴')
 if(recipient==='member')return decide(false,'other','结合群聊前文识别为对其他成员说话',Math.round(semantic!.recipient!.confidence*100))
 if(recipient==='partner')return {
  ...decide(true,'continuation','结合发言人、回复对象和前文识别为对伙伴说话',Math.round(semantic!.recipient!.confidence*100)),
  followupRequest:true,
 }
 if(event.qqGroup?.otherMention)return isAttentionCall(semantic)
  ?decide(true,'semantic','本地语义识别为向伙伴提问，@ 的成员是谈论对象',Math.round(semantic!.confidence*100))
  :decide(false,'other','提及其他成员，但缺少向伙伴说话的明确语义依据')
 if(semantic){
  const score=Math.round(semantic.confidence*100)
  const scene=semantic.scene,sceneClear=isClearScene(scene)
  const called=isAttentionCall(semantic)
  const otherScene=scene?.label==='other'&&(context.otherConversation||semantic.label==='other'||sceneClear&&(!called||scene.confidence>=.6))
  const otherIntent=semantic.label==='other'&&(context.otherConversation||semantic.confidence>=.72&&semantic.margin>=.35)
  if(otherScene||otherIntent)
   return decide(false,'other','场景指向其他成员，先旁听',score)
  if(called)return decide(true,'semantic','本地语义识别为呼唤，按呼唤证据接入',score)
  const question=sceneClear&&scene?.label==='question'
  const replySimilarity=semantic.replySimilarity??0
  if(context.latestReplyToSpeaker&&replySimilarity>=.4&&asksForFollowup(text))
   return {...decide(true,'continuation','承接伙伴在群里已送达的回复并提出后续请求，结合前文接话',score),followupRequest:true}
  if(sceneClear&&['close','background'].includes(scene!.label))return decide(false,'semantic','场景识别：'+(scene!.label==='close'?'确认或收尾':'没有交流内容')+'，先旁听',Math.round(scene!.confidence*100))
  const strongNegative=['other','close','background'].includes(semantic.label)&&semantic.confidence>=.72&&semantic.margin>=.35
  const comparesSpeakerReply=activeConversation(context)&&(!context.latestReplyInRoom||context.latestReplyToSpeaker)
  if((!strongNegative||question)&&comparesSpeakerReply&&text&&replySimilarity>=.4&&(!context.otherConversation||question&&replySimilarity>=.55))
   return decide(true,'continuation','内容承接伙伴刚才的实际回复，进入上下文判断',score)
  if(context.quietRecent&&!context.groupRecent&&!context.otherConversation&&!strongNegative&&(semantic.contextSimilarity??0)>=.45){
   return decide(true,'continuation','群聊停顿后继续刚才有送达记录的话题',score)
  }
  if(sceneClear&&['question','banter','share','topic'].includes(scene!.label)){
   const related=topicContinues(text,{...context,semantic})
   const names={question:'求助或观点交流',banter:'玩笑、接梗或吐槽',share:'分享见闻或情绪',topic:'开启新话题'}
   const reason=`场景识别：${names[scene!.label as keyof typeof names]}`
   if(!context.otherConversation&&!context.groupRecent&&(semantic.replySimilarity??0)>=.4)
    return decide(true,'continuation',reason+'；与已送达的回复相关',score)
   if(related&&context.singleParticipant)return decide(true,'continuation',reason+'，延续与同一成员的讨论',score)
   if(related)return opportunity(question ? .45 : .28,score,reason+'；群里正在聊同一话题，选择性接话')
   const interested=(semantic.profileSimilarity??0)>=.45
   const priority=question||scene!.label==='topic'
   const probability=priority ? (context.otherConversation ? .5 : .75) : interested ? .65 : context.otherConversation ? .25 : .5
   return opportunity(probability,Math.round(scene!.confidence*100),reason+'；'+(interested?'与当前伙伴设定相关，选择是否参与':context.otherConversation?'其他成员正在交流，克制插话':'有参与机会，选择是否接话'))
  }
  const clear=semantic.confidence>=.65&&semantic.margin>=.15||semantic.confidence>=.58&&semantic.margin>=.2||semantic.confidence>=.52&&semantic.margin>=.25
  const related=semantic.confidence>=.48&&semantic.margin>=.12&&(semantic.contextSimilarity??0)>=.4
  if(['engage','address'].includes(semantic.label)&&topicContinues(text,{...context,semantic})){
   if(!clear&&!related)return decide(false,'semantic','内容与当前话题相关，缺少明确的接话意图',score)
   if(context.singleParticipant)return decide(true,'continuation','同一成员继续当前讨论',score)
   return opportunity(.28,score,'与群内已经参与过的话题相关，选择性接话')
  }
  if(['address','engage'].includes(semantic.label)&&(clear||related)){
   if(semantic.label==='engage'&&context.otherConversation&&!/大家|各位|有没有人|有人(?:知道|会|能)|你们(?:觉得|怎么看)/u.test(text)){
    // A chance to join shared chatter, not an obligation to answer every participant.
    return opportunity(context.groupRecent ? .28 : .45,score,'本地语义发现可交流内容，选择是否加入群友对话')
   }
   return decide(true,'semantic',clear?'本地语义识别为呼唤或交流':'结合近期群聊话题，识别到接话机会',score)
  }
  if(!context.otherConversation&&['close','background'].includes(semantic.label)&&!strongNegative&&((semantic.contextSimilarity??0)>=.6||semantic.confidence<.58&&semantic.margin<.2&&(semantic.contextSimilarity??0)>=.32)){
   return {reply:true,route:'opportunity',score,probability:1,reasons:['单句意图不确定，但与近期群聊高度相关，交给当前对话判断']}
  }
  if(semantic.confidence>=.72&&semantic.margin>=.35&&['other','close','background'].includes(semantic.label))return decide(false,'semantic',`本地语义明确识别为 ${semantic.label}`,score)
 }
 if(!semantic&&context.singleParticipant&&text&&topicContinues(text,context))
  return decide(true,'continuation','已与这位成员建立讨论，按上下文继续接话')
 if(text||event.media?.length)return decide(false,'fallback',semantic?'没有明确接话依据，继续旁听':'本地语义暂不可用且未被呼唤，继续旁听')
 return decide(false,'fallback','空消息')
}
