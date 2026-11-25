import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationLocation, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatReplyFromEvent, type ChatReply } from './protocol.js'

/** Project durable delivery metadata into the host's normal assistant renderer.
 * This is a view only: no synthetic assistant messages or history rewrites.
 */
export function nativeChatBlocks(reply: ChatReply, base = typeof document === 'undefined' ? undefined : document.baseURI, textAlreadyShown = false): Array<{kind:'text';text:string}> {
  if(reply.deliveryKind==='text'&&reply.delivered)return !textAlreadyShown&&reply.spokenText?[{kind:'text',text:reply.spokenText}]:[]
  if(reply.delivered===true&&!reply.parts.length)return [{kind:'text',text:'[语音已发送]'+(!textAlreadyShown&&typeof reply.spokenText==='string'?' '+reply.spokenText:'')}]
  const parts=textAlreadyShown?reply.parts.filter(part=>part.type!=='text'):reply.parts
  return parts.map(part => ({kind:'text', text:part.type==='text' ? part.text
    : part.type==='emoji' ? (part.emoji.previewUrl ? `![${part.emoji.label.replace(/[\\\[\]]/g,'')}](${encodeURI(part.emoji.previewUrl).replace(/[()]/g,c=>`%${c.charCodeAt(0).toString(16)}`)})` : `[表情：${part.emoji.label}]`) : `![${part.label.replace(/[\\\[\]]/g,'\\$&')}](${encodeURI(base ? new URL(part.url, base).href : part.url).replace(/[()]/g,c=>`%${c.charCodeAt(0).toString(16)}`)})`}))
}
interface AssistantStepView {
  status: string
  finalNode?: {seq:number}
  blocks: readonly ({kind:'text';text:string}|{kind:'tool-call';callId:string}|{kind:'other'})[]
}
const normalizeText = (text:string) => text.replace(/\r\n/g,'\n').trim()

/** A terminal call's companion prose and its receipt are one expression.
 * Providers sometimes paraphrase the authored arguments beside the call. Match
 * ownership, not text similarity; unrelated calls and intermediate speech keep
 * their independent content. The native tool result still exposes the receipt.
 */
function assistantAlreadyShows(reply: ChatReply, event: SessionEvent, location: ConversationLocation): boolean {
  if(location.kind!=='step')return false
  const callId=event.type==='tool/result'?event.data.message.toolCallId:event.type==='tool/ptc-dispatch'?event.data.rootCallId:undefined
  if(!callId)return false
  const data=location.step.data as {get(key:'assistant-step'):AssistantStepView|undefined}
  const native=data.get('assistant-step')
  if(native?.status!=='settled'||native.finalNode===undefined||native.finalNode.seq>=event.seq||
    !native.blocks.some(block=>block.kind==='tool-call'&&block.callId===callId))return false
  const shown=normalizeText(native.blocks.flatMap(block=>block.kind==='text'?[block.text]:[]).join(''))
  const calls=native.blocks.filter(block=>block.kind==='tool-call')
  if(shown&&!reply.intermediate&&!reply.taskPreamble&&calls.length===1)return true
  const receipt=reply.delivered&&(reply.deliveryKind==='text'||!reply.parts.length)
    ? [reply.spokenText??'']
    : reply.parts.flatMap(part=>part.type==='text'?[part.text]:[])
  return !!shown&&(shown===normalizeText(receipt.join('\n'))||shown===normalizeText(receipt.join('\n\n')))
}
export const chatReplyDefinition:ConversationNodeDefinition<ChatReply>={
  kind:'partner-chat-reply',target:'chat',
  match:event=>chatReplyFromEvent(event as SessionEvent)?{id:`reply-${event.seq}`,role:'start'}:null,
  start:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  update:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  buildViewNode:context=>{
    if (!context.state||!context.start||context.state.transportCallId) return null
    const {event,location}=context.start
    const blocks=nativeChatBlocks(context.state,undefined,assistantAlreadyShows(context.state,event as SessionEvent,location))
    if(!blocks.length)return null
    return {key:context.key,id:context.id,kind:'assistant-step',target:'chat',anchorSeq:event.seq,location,
      visibility:'visible',groupTree:'turn',data:{status:'settled',turn:'turn' in event.data?event.data.turn:0,
        step:'step' in event.data?event.data.step:0,time:event.time,blocks}}
  },
}
export function registerChatReplies(ctx:Context):void {
  const runtime=ctx as unknown as {inject(names:string[],callback:(scope:Context)=>void):unknown}
  const registered=new WeakSet<object>()
  const register=(scope:Context,modern:boolean)=>{
    type Registry={register(definition:ConversationNodeDefinition<ChatReply>):()=>void}
    const registry=modern?scope.get('conversationEvents') as Registry:(scope.get('uiConversation') as {events:Registry}).events
    if(registered.has(registry))return
    registered.add(registry)
    scope.effect(()=>{const dispose=registry.register(chatReplyDefinition);return()=>{registered.delete(registry);dispose()}},'partner: chat replies')
  }
  runtime.inject(['uiConversation'],scope=>register(scope,false));runtime.inject(['conversationEvents'],scope=>register(scope,true))
}
