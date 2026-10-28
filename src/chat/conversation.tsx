import { useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatReplyFromEvent, type ChatReply } from './protocol.js'

// A terminal reply is turn content, outside the collapsible tool process.
// Keep native tool-result consumers subscribed so their call state also settles.
export const chatReplyDefinition:ConversationNodeDefinition<ChatReply>={
  kind:'partner-chat-reply',target:'chat',
  match:event=>chatReplyFromEvent(event as SessionEvent)?{id:`reply-${event.seq}`,role:'start'}:null,
  start:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  update:(_ctx,match)=>chatReplyFromEvent(match.event as SessionEvent)!,
  buildViewNode:context=>context.state&&context.start?{key:context.key,id:context.id,kind:'partner-chat-reply',target:'chat',anchorSeq:context.start.event.seq,location:context.start.location,visibility:'visible',groupTree:'turn',data:context.state}:null,
}
function StickerImage({url,label}:{url:string;label:string}) {
  const [failed,setFailed]=useState(false)
  return failed?<span className="dsh-partner-chat-image-missing">表情：{label}（图片已清理或暂时不可用）</span>:<img src={url} alt={label} loading="lazy" onError={()=>setFailed(true)} />
}
export function ChatBubbles({data}:{data:ChatReply}) {
  return <div className="dsh-partner-chat-bubbles" aria-label="伙伴回复">{data.parts.map((part,i)=>part.type==='text'?<div key={i} className="dsh-partner-chat-bubble">{part.text}</div>:<div key={i} className="dsh-partner-chat-sticker"><StickerImage url={part.url} label={part.label}/></div>)}</div>
}
export function registerChatReplies(ctx:Context):void {
  const runtime=ctx as unknown as {
    inject(names:string[],callback:(scope:Context)=>void):unknown
    slots:{inject(name:string,callback:()=>unknown):unknown;register(options:{name:string;key:string},render:(props:{node:{data:ChatReply}})=>JSX.Element):()=>void}
  }
  const registered=new WeakSet<object>()
  const register=(scope:Context,modern:boolean)=>{
    type Registry={register(definition:ConversationNodeDefinition<ChatReply>):()=>void}
    const registry=modern?scope.get('conversationEvents') as Registry:(scope.get('uiConversation') as {events:Registry}).events
    if(registered.has(registry))return
    registered.add(registry)
    scope.effect(()=>{const dispose=registry.register(chatReplyDefinition);return()=>{registered.delete(registry);dispose()}},'partner: chat replies')
  }
  runtime.inject(['uiConversation'],scope=>register(scope,false));runtime.inject(['conversationEvents'],scope=>register(scope,true))
  runtime.slots.inject('conversation.chat.node',()=>runtime.slots.register({name:'conversation.chat.node',key:'partner-chat-reply'},props=><ChatBubbles data={props.node.data}/>))
}
