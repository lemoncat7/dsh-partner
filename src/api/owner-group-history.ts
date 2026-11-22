import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent,SessionId} from '@deepseek-ai/dsh-session'
import type {ChannelSession,PartnerState} from '../domain.js'
import {boundQqIds,qqGroupPeer,qqSettings} from '../channels/qq/settings.js'
import {inputOrigins} from '../channels/input-origin.js'
import {conversationReplyText,isInternalTaskNotice} from '../channels/delivery-policy.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {shiftCalendarDay} from '../memory-calendar.js'

interface GroupSource {id:string;title:string;routes:ChannelSession[]}
interface GroupTurn {id:string;at:number;user:string;assistant:string;accountId:string}
type ReadSession={inheritedEventCount:number;read(offset:number):Promise<{events:SessionEvent[]}>;close():Promise<void>}
type Hosts=Context & {agents?:{get(id:SessionId):{session:{snapshotEvents():readonly SessionEvent[]}}|undefined}}

export function ownerGroupSources(state:PartnerState,companionId:string):GroupSource[] {
  const channels=new Map(state.channels.filter(c=>c.companionId===companionId&&c.platform==='qq'&&c.enabled).map(c=>[c.id,c]))
  const groups=new Map<string,GroupSource>()
  for(const route of state.sessions){
    if(route.kind!=='channel'||route.companionId!==companionId)continue
    const c=channels.get(route.channelId),peer=qqGroupPeer(route.userId)
    if(!c||!peer)continue
    const policy=qqSettings(c.qq)
    if(!policy.groupReplies||!policy.groupIds.includes(peer.groupId)||!boundQqIds(policy.identityBinding).includes(peer.userId))continue
    const id=JSON.stringify([route.channelId,peer.groupId])
    const existing=groups.get(id)
    if(existing)existing.routes.push(route)
    else groups.set(id,{id,title:route.qqSessionTitle||'QQ 群 · '+peer.groupId,routes:[route]})
  }
  return [...groups.values()]
}

/** Same-room, verified-identity projection of the original log. No writes to long-term memory. */
export function ownerGroupTurns(events:readonly SessionEvent[],routes:readonly ChannelSession[]): GroupTurn[] {
  const routesById=new Map(routes.map(route=>[route.id,route]))
  const currentIds=new Map(routes.flatMap(route=>(route.inboundMessageIds??[]).map(id=>[id,route] as const)))
  const origins=new Map(inputOrigins(events).map(item=>[item.messageId,item]))
  const turns:GroupTurn[]=[]
  let current:{record:GroupTurn;start:number}|undefined
  const finish=(end:number)=>{
    if(!current)return
    const reply=conversationReplyText(events.slice(current.start,end))
    current.record.assistant=reply.trim().slice(0,12000)
    turns.push(current.record)
    current=undefined
  }
  for(let i=0;i<events.length;i++){
    const event=events[i]!
    if(event.type==='turn/end'){finish(i+1);continue}
    if(event.type==='turn/start'||isInternalTaskNotice(event)||isIdleContactNotice(event)){finish(i);continue}
    if(event.type!=='user/message'||event.data.source.kind!=='user'||event.surfaceOp!=='append')continue
    finish(i)
    const id=event.data.id, origin=origins.get(id)
    const route=origin?routesById.get(origin.routeId):currentIds.get(id)
    if(!route||origin&&(origin.channelId!==route.channelId||origin.userId!==route.userId))continue
    const accountId=qqGroupPeer(route.userId)?.userId
    if(!accountId)continue
    // The raw transport text excludes forwarded quotes and the ambient group buffer.
    const source=origin?.imageRequest?.replace(/^\[对方 @ 了你\]\s*/u,'').trim()
    const legacy=event.data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
    const envelope=/^\[QQ 群 \d+ · 发言人 [^\r\n]+\]\r?\n/m.exec(legacy)
    const tail=envelope?legacy.slice(envelope.index+envelope[0].length):''
    const user=(source??(tail.includes('[引用结束]')?tail.slice(tail.lastIndexOf('当前发言：')+'当前发言：'.length):tail).trim()).slice(0,12000)
    if(!user&&!origin)continue
    current={record:{id,at:event.time,user:user||'附件消息',assistant:'',accountId},start:i}
  }
  finish(events.length)
  return turns
}

const cache=new WeakMap<Context,Map<string,{expires:number;pending:Promise<GroupTurn[]>}>>()
export async function loadOwnerGroupTurns(ctx:Hosts,source:GroupSource):Promise<GroupTurn[]> {
  const room=source.routes[0]!
  const key=JSON.stringify([source.id,room.companionId,source.routes.map(r=>[r.id,r.sessionId,r.userId])])
  const available=cache.get(ctx)??new Map()
  cache.set(ctx,available)
  const current=available.get(key)
  if(current&&current.expires>Date.now())return current.pending
  const pending=Promise.all([...new Set(source.routes.map(r=>r.sessionId))].map(async id=>{
    const live=ctx.agents?.get(id as SessionId)
    const routes=source.routes.filter(r=>r.sessionId===id)
    if(live)return ownerGroupTurns(live.session.snapshotEvents(),routes)
    const persistence=ctx.get('sessionPersistence') as {open(id:string,mode:'read'):Promise<ReadSession>}|undefined
    if(!persistence)return []
    const file=await persistence.open(id,'read')
    try{return ownerGroupTurns((await file.read(file.inheritedEventCount)).events,routes)}finally{await file.close()}
  })).then(result=>[...new Map(result.flat().map(turn=>[turn.id,turn])).values()].sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id)))
  if(available.size>=24)available.delete(available.keys().next().value!)
  available.set(key,{expires:Date.now()+15_000,pending})
  try{return await pending}catch(error){available.delete(key);throw error}
}

export function ownerGroupTimeline(turns:readonly GroupTurn[],timeZone:string,now=Date.now(),through?:string) {
  const format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
  const today=format.format(now), last=through&&through<today?through:today
  const start=shiftCalendarDay(last,-27)
  const totals=new Map<string,number>()
  for(const item of turns){
    const date=format.format(item.at)
    totals.set(date,(totals.get(date)??0)+1)
  }
  const days=Array.from({length:28},(_,index)=>{
    const day=shiftCalendarDay(start,index)
    return {day,turns:totals.get(day)??0,pending:0}
  })
  return {timeZone,today,days}
}
