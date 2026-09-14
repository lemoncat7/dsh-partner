import type {SessionEvent} from '@deepseek-ai/dsh-session'

export type ReplyStage = 'queued' | 'working' | 'tools' | 'composing'
export type ReplyProgress = (stage:ReplyStage)=>void

/** Deliberately expose only fixed labels, never tool names, arguments or reasoning. */
export function replyStage(event:SessionEvent):ReplyStage|undefined {
  if(event.type==='tool/call')return 'tools'
  if(event.type==='request/header')return 'composing'
  return undefined
}
export function reportProgress(notify:ReplyProgress|undefined,stage:ReplyStage):void {
  try{notify?.(stage)}catch{ /* A UI observer cannot interrupt agent execution. */ }
}
