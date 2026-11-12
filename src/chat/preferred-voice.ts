import {ToolCallId} from '@deepseek-ai/dsh-llm'
import type {ToolRunContext} from '@deepseek-ai/dsh-tools'
import {scopeTarget} from '@deepseek-ai/dsh-scope'
import {dispatchTool} from '../compat/tool-dispatch.js'
import type {PartnerStore} from '../store.js'
import {questionOrigin} from '../channels/question-origin.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {resolveToolAccess} from '../execution/tool-access-adapter.js'
import {supportsChannelTts} from '../voice/domain.js'
import {qqGroupRoute} from '../channels/qq/settings.js'
import type {ChatReply} from './protocol.js'

export const REPLY_DELIVERY_SCHEMA={type:'string',enum:['auto','text','voice'],description:'默认 auto：仅私聊开启短句优先语音且当前渠道可用时，简短口语自动合成发送，长内容仍文字；群聊不应用此偏好，默认文字。对方要求文字、安静或内容需要回看时选 text；明确需要语音选 voice，群聊仍可显式使用语音。沿用当前人物正文，不再转述。'}
export interface ReplyDeliveryOptions {delivery?:'auto'|'text'|'voice';preserveText?:boolean;inlineDetails?:boolean}
export function shortSpokenText(parts:readonly {text?:string}[]):string|undefined {
 if(parts.length!==1||parts.some(p=>typeof p.text!=='string'||!p.text.trim()))return
 const text=parts.map(p=>p.text!.trim()).join(' ')
 if(text.length>80||/[\n\r]|https?:\/\/|www\.|```|[<>\[\]{}]|(?:^|\s)(?:[-*#]|\d+[.)])\s|(?:\/[^\s/]+){2,}/u.test(text))return
 if((text.match(/\p{P}/gu)??[]).length>3||(text.match(/[。！？.!?]/gu)??[]).length>2)return
 return text
}
/** Use the existing scoped voice tool; no second model, new recipient or top-level capability. */
export async function sendPreferredVoice(owner:string,store:PartnerStore,exec:ToolRunContext,parts:readonly {text?:string}[],options:ReplyDeliveryOptions={}):Promise<ChatReply|undefined>{
 if(options.delivery!==undefined&&!['auto','text','voice'].includes(options.delivery))throw Error('回复方式无效')
 if(options.delivery==='text'||options.preserveText||options.inlineDetails)return
 const state=store.snapshot(),card=state.companions.find(c=>c.id===owner)?.characterCard,agent=exec.agent
 if(!agent||options.delivery!=='voice'&&!(card?.length==='short'&&card.shortVoiceReplies))return
 const texts=parts.map(part=>shortSpokenText([part]))
 if(!texts.length||texts.some(text=>!text)){if(options.delivery==='voice')throw Error('此回复包含长内容或非口语内容；请用文字，或单独通过语音工具发送合适的台词');return}
 const events=agent.session.snapshotEvents(),input=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
 const route=input&&isIdleContactNotice(input)&&input.type==='user/message'?state.sessions.find(r=>r.sessionId===agent.session.id&&r.idleContactState?.messageId===input.data.id):questionOrigin(agent.session.id,events,state.sessions)
 if(options.delivery!=='voice'&&route&&qqGroupRoute(route,state.channels))return
 const channel=state.channels.find(c=>c.id===route?.channelId&&c.companionId===owner)
 const access=resolveToolAccess({agent,state}),runtime=agent.ctx.tools
 const available=route?.companionId===owner&&channel?.enabled&&supportsChannelTts(channel.platform)&&channel.tts?.enabled&&state.companions.find(c=>c.id===owner)?.ttsProfiles?.some(p=>p.id===channel.tts!.profileId)&&access.sendTools&&(!access.allowedTools||access.allowedTools.includes('partner_voice_reply'))&&runtime.get('partner_voice_reply',agent)
 if(!available){if(options.delivery==='voice')throw Error('当前渠道没有可用的语音 TTS，请核对语音状态或改用文字');return}
 const receipts:ChatReply[]=[]
 for(const [index,text] of texts.entries()){
 exec.signal.throwIfAborted()
 const latest=[...agent.session.snapshotEvents()].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
 if(latest?.type!=='user/message'||input?.type!=='user/message'||latest.data.id!==input.data.id)throw Error('当前输入已变化，停止发送剩余语音；已送达的消息不重复发送')
 const subCallId=ToolCallId(`${exec.callId}:reply-voice${index?':'+(index+1):''}`),rootCallId=exec.rootCallId??exec.callId
 const args={action:'speak',text,continueTurn:true},log={rootCallId,parentCallId:exec.callId,subCallId,name:'partner_voice_reply',arguments:JSON.stringify(args)}
 agent.session.append('tool/ptc-dispatch-start',log)
 const result=await dispatchTool(runtime,{name:log.name,arguments:args,agent,signal:exec.signal,callId:subCallId,rootCallId,parent:exec.token,...(exec.toolSet?{toolSet:exec.toolSet}:{})})
 let content=result.content
 try{content=await agent.ctx.waterfall(scopeTarget(runtime,agent),'tools/ptc-dispatch-log',{exec,agent,subCallId,name:log.name,isError:result.isError,content},()=>Promise.resolve(content))}catch{/* Retain the settled receipt. */}
 agent.session.append('tool/ptc-dispatch',{...log,isError:result.isError,content,...(result.meta===undefined?{}:{meta:result.meta}),...(result.error?.info===undefined?{}:{error:result.error.info})})
 for(const context of result.additionalContexts??[])exec.deferContext(context)
 if(result.isError)throw Error(`本次已确认发送 ${receipts.length} 条语音。语音调用未成功，先核对该调用回执；发送状态不明时不要再发同义文字或重试。`+content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n').slice(0,500))
 const receipt=result.meta as ChatReply|undefined
 if(receipt?.kind!=='partner-chat-v1'||!receipt.delivered)throw Error('语音未返回确认回执，请核对后再继续，不重复发送')
 receipts.push({...receipt,transportCallId:subCallId})
 }
 const last=receipts[receipts.length-1]!
 return {...last,spokenText:receipts.map(r=>r.spokenText??'').join('\n')}
}
