import {appendPluginRecord,pluginRecordOf,type Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {ImageAttachmentRef} from '@deepseek-ai/dsh-attachment'

export interface ImageInputOrigin {
  imageRequest?:string
  imageMissing?:boolean
  imageScope?:string
  imageSources?:Array<{messageId:string;image:ImageAttachmentRef}>
}

type InputOrigin={messageId:string;routeId:string;channelId:string;userId:string}&ImageInputOrigin

function readOrigin(event:SessionEvent):InputOrigin|undefined {
  const record=pluginRecordOf(event)
  if(record?.type!=='plugin:dsh-partner/input-origin')return
  const data=record.data as Partial<InputOrigin>|null
  if(data&&['messageId','routeId','channelId','userId'].every(k=>typeof data[k as keyof InputOrigin]==='string'))return data as InputOrigin
}

export function inputOrigins(events:readonly SessionEvent[]):InputOrigin[]{
  return events.flatMap(event=>readOrigin(event)??[])
}

export function inputOrigin(events:readonly SessionEvent[],messageId:string):InputOrigin|undefined {
  for(let index=events.length-1;index>=0;index--){
    const origin=readOrigin(events[index]!)
    if(origin?.messageId===messageId)return origin
  }
}

export function recordInputOrigin(session:Session,data:InputOrigin):void {
  appendPluginRecord(session,'plugin:dsh-partner/input-origin',data)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {'plugin:dsh-partner/input-origin':InputOrigin}
}
