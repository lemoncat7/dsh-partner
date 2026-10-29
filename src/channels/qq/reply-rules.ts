import type { DirectMessage } from '../direct/transport.js'
import type { AttentionPrediction } from './attention-classifier.js'

export interface ReplyScore { reply:boolean; score:number; probability:number; reasons:string[]; route:'direct'|'continuation'|'semantic'|'fallback'|'other'|'closing' }
export interface ReplyScoreContext { name:string; owner:boolean; affection:number; recent?:{at:number;text:string}; now:number; seed:string; addresses?:readonly string[]; semantic?:AttentionPrediction }
const normalized=(text:string)=>text.slice(0,1200).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu,'').slice(0,160)
export function topicSimilarity(left:string,right:string):number {
 const grams=(text:string)=>{const chars=Array.from(normalized(text)),out=new Set<string>();for(let i=1;i<chars.length;i++)out.add(chars[i-1]!+chars[i]!);return out}
 const a=grams(left),b=grams(right);if(!a.size||!b.size)return 0
 let common=0;for(const gram of a)if(b.has(gram))common++
 return 2*common/(a.size+b.size)
}
export const CONVERSATION_WINDOW_MS=5*60_000
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
 return !tail||/^[\s,，:：!！?？、]/u.test(tail)||/^(?:你|人呢|在吗|在不在|出来|来一下|帮我|帮忙|能不能|可以|会不会)/u.test(tail)
}
/** Strong routing facts run before semantics. No random draw in a live conversation. */
export function routeGroupReply(event:DirectMessage,context:ReplyScoreContext):ReplyScore|undefined {
 const text=event.text.trim(),group=event.qqGroup
 const decide=(reply:boolean,route:ReplyScore['route'],reason:string):ReplyScore=>({reply,route,score:reply?100:0,probability:reply?1:0,reasons:[reason]})
 if(group?.mentioned)return decide(true,'direct','明确 @ 伙伴')
 if(group?.replyTo==='self')return decide(true,'direct','引用伙伴已确认发送的消息')
 if(group?.otherMention||group?.replyTo==='other')return decide(false,'other','消息明确发给其他成员')
 if(conversationEnded(text))return decide(false,'closing','用户明确结束或暂停接话')
 if(!group?.hasReply&&directAddress(text,context.name.trim()))return decide(true,'direct','直接叫到角色名字')
 if(context.owner&&!group?.hasReply&&(context.addresses??[]).some(name=>directAddress(text,name)))return decide(true,'direct','归属账号使用关系称呼呼唤')
 // A successful delivered reply establishes one speaker's thread; another speaker does not erase it.
 if(activeConversation(context))return decide(true,'continuation','接续与此人的对话，不逐条抽签')
 return undefined
}
export function scoreGroupReply(event:DirectMessage,context:ReplyScoreContext):ReplyScore {
 const routed=routeGroupReply(event,context);if(routed)return routed
 const text=event.text.trim(),semantic=context.semantic
 const decide=(reply:boolean,route:ReplyScore['route'],reason:string,score=reply?100:0):ReplyScore=>({reply,route,score,probability:reply?1:0,reasons:[reason]})
 // Closing acknowledgements only suppress a NEW conversation, never an ongoing exchange.
 if(!event.media?.length&&/^(?:嗯{1,3}|好|好的|收到|ok|知道了|了解)[\s。.!！~～]*$/iu.test(text))return decide(false,'closing','独立确认语，没有正在接续的对话')
 if(semantic){
  const score=Math.round(semantic.confidence*100)
  if(['address','engage'].includes(semantic.label)&&semantic.confidence>=.38)return decide(true,'semantic','本地语义识别为呼唤或交流',score)
  // An uncertain classification must never become a hard rejection. Guests also get this fallback.
  if(semantic.confidence>=.72&&semantic.margin>=.35&&['other','close','background'].includes(semantic.label))return decide(false,'semantic',`本地语义明确识别为 ${semantic.label}`,score)
 }
 if(event.media?.length)return decide(true,'fallback','附件交给回复模型结合上下文判断')
 if(text)return decide(true,'fallback',semantic?'语义归属不确定，交给回复模型判断':'本地语义暂不可用，保留消息进入回复流程')
 return decide(false,'fallback','空消息')
}
