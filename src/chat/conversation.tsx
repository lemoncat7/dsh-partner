import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatReplyFromEvent, type ChatReply } from './protocol.js'

/** Project durable delivery metadata into the host's normal assistant renderer.
 * This is a view only: no synthetic assistant messages or history rewrites.
 */
export function nativeChatBlocks(reply: ChatReply): Array<{kind:'text';text:string}> {
  return reply.parts.map(part => ({kind:'text', text:part.type==='text' ? part.text
    : `![${part.label.replace(/[\\\[\]]/g,'\\$&')}](${encodeURI(part.url).replace(/[()]/g,c=>`%${c.charCodeAt(0).toString(16)}`)})`}))
}
export const chatReplyDefinition:ConversationNodeDefinition<ChatReply>={
  kind:'partner-chat-reply',target:'chat',
  match:event=>chatReplyFromEvent(event as SessionEvent)?{id:`reply-${event.seq}`,role:'start'}:null,
  start:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  update:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  buildViewNode:context=>{
    if (!context.state||!context.start) return null
    const {event,location}=context.start
    return {key:context.key,id:context.id,kind:'assistant-step',target:'chat',anchorSeq:event.seq,location,
      visibility:'visible',groupTree:'turn',data:{status:'settled',turn:'turn' in event.data?event.data.turn:0,
        step:'step' in event.data?event.data.step:0,time:event.time,blocks:nativeChatBlocks(context.state)}}
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
