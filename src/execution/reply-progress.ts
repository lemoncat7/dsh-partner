import type {SessionEvent} from '@deepseek-ai/dsh-session'

export type ReplyStage = 'queued' | 'working' | 'tools' | 'composing'
export type ReplyActivity = {kind:'text';text:string} | {kind:'tool-start';id:string;name:string} | {kind:'tool-end';id:string;failed:boolean}
export type ReplyProgress = (stage:ReplyStage | ReplyActivity)=>void

/** Deliberately expose only fixed labels, never tool names, arguments or reasoning. */
export function replyStage(event:SessionEvent):ReplyStage|undefined {
  if(event.type==='tool/call')return 'tools'
  if(event.type==='request/header')return 'composing'
  return undefined
}
export function replyActivity(event:SessionEvent):ReplyActivity|undefined {
  if(event.type==='tool/call')return {kind:'tool-start',id:event.data.callId,name:/^[\w.:-]{1,100}$/.test(event.data.name)?event.data.name:'工具'}
  if(event.type==='tool/result')return {kind:'tool-end',id:event.data.message.content[0].toolCallId,failed:!!event.data.error||!!event.data.message.content[0].isError}
  if(event.type==='assistant/message'&&!event.data.interrupted&&event.data.message.content.some(block=>block.type==='tool-call')){
    const text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
    if(text)return {kind:'text',text}
  }
  return undefined
}
export function reportProgress(notify:ReplyProgress|undefined,stage:ReplyStage|ReplyActivity):void {
  try{notify?.(stage)}catch{ /* A UI observer cannot interrupt agent execution. */ }
}
