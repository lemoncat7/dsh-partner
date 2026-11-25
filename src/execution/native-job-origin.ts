import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession, PartnerState } from '../domain.js'
import { inputOrigin } from '../channels/input-origin.js'
import { directReplyTarget, channelReplyAllowed } from '../channels/reply-access.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export interface NativeJobOrigin {
  jobId: string; sessionId: string; inputId: string; owner: string; routeId: string
  channelId: string; userId: string; accountId: string; baseUrl: string; targetId: string
}
const recordType = 'plugin:dsh-partner/native-job-origin'
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:dsh-partner/native-job-origin': NativeJobOrigin }
}

function noticeOrigin(sessionId:string,events:readonly SessionEvent[],notice:UserMessage):NativeJobOrigin|undefined {
  if(String(notice.source.kind)!=='tool-jobs')return
  const text=notice.content.find(part=>part.type==='text')
  const jobId=text?.type==='text'?/^background job ([^\s]+) \(/u.exec(text.text)?.[1]:undefined
  if(!jobId)return
  for(let index=events.length-1;index>=0;index--){
    const record=pluginRecordOf(events[index]!)
    if(record?.type!==recordType)continue
    const data=record.data as Partial<NativeJobOrigin>|undefined
    if(data?.jobId!==jobId||data.sessionId!==sessionId)continue
    if(['jobId','sessionId','inputId','owner','routeId','channelId','userId','accountId','baseUrl','targetId'].every(key=>typeof data[key as keyof NativeJobOrigin]==='string'))return data as NativeJobOrigin
  }
}

/** Include native jobs in Partner's busy indicator, even when its agent is idle. */
export function nativeJobActivity(ctx:Context,sessionId:string,events:()=>readonly SessionEvent[],channelId?:string):Array<{kind:string;label:string;sessionId:string}> {
  const jobs=ctx.get?.('jobs' as never) as {list?(owner:string):Array<{id:string;owner?:string;status:string}>}|undefined
  const active=jobs?.list?.(sessionId).filter(job=>job.owner===sessionId&&['running','stopping'].includes(job.status))??[]
  if(!active.length)return []
  const history=channelId?events():[]
  return active.filter(job=>!channelId||history.some(event=>{
    const record=pluginRecordOf(event),origin=record?.data as Partial<NativeJobOrigin>|undefined
    return record?.type===recordType&&origin?.jobId===job.id&&origin.sessionId===sessionId&&origin.channelId===channelId
  })).map(()=>({kind:'job',label:'原生后台任务正在运行',sessionId}))
}

/** Keep completed jobs in their own native turns when another user or route is present. */
export function installNativeJobTurns(ctx:Context,owns:(agent:Agent)=>boolean):()=>void {
  return ctx.on('agent/pre-step',async({agent},next)=>{
    const decision=await next()
    if(decision.kind!=='enter'||!owns(agent)||!decision.messages.some(message=>String(message.source.kind)==='tool-jobs'))return decision
    const user=decision.messages.some(message=>message.source.kind==='user'),events=agent.session.snapshotEvents()
    let selected:string|undefined
    const messages=decision.messages.filter(message=>{
      if(String(message.source.kind)!=='tool-jobs')return true
      const origin=noticeOrigin(agent.session.id,events,message),key=origin?.routeId??message.id
      if(!user&&(selected===undefined||selected===key)){selected=key;return true}
      agent.followup(message)
      return false
    })
    return messages.length?{...decision,messages}:{kind:'reject'}
  })
}

/** Record only delivery ownership; native Jobs owns execution, status, output and UI. */
export function recordNativeJobOrigin(session: Session, event: SessionEvent, state: PartnerState): void {
  if (String(event.type) !== 'job/registered') return
  const data = event.data as unknown as { jobId?: unknown; owner?: unknown }
  if (typeof data.jobId !== 'string' || data.owner !== session.id) return
  const events = session.snapshotEvents().filter(item => item.seq < event.seq)
  const turn = [...events].reverse().find(item => item.type === 'turn/start')
  const input = [...events].reverse().find(item => item.type === 'user/message' && item.data.source.kind === 'user' && item.seq > (turn?.seq ?? -1))
  if (input?.type !== 'user/message') return
  const source = inputOrigin(events, input.data.id)
  const linked=state.sessions.filter(route=>route.sessionId===session.id)
  const route = source ? linked.find(route=>route.id===source.routeId&&route.channelId===source.channelId&&route.userId===source.userId)
    : linked.find(route=>route.kind==='channel'&&route.inboundMessageIds?.includes(input.data.id))??linked.find(route=>route.kind==='local')
  if (!route) return
  const channel = state.channels.find(item => item.id === route.channelId)
  appendPluginRecord(session, recordType, {
    jobId: data.jobId, sessionId: session.id, inputId: input.data.id, owner: route.companionId, routeId: route.id,
    channelId: route.channelId, userId: route.userId, accountId: channel?.accountId ?? '', baseUrl: channel?.direct?.baseUrl ?? '',
    targetId: route.kind === 'local' ? '' : directReplyTarget(state, route.channelId, route.userId),
  })
}

/** A native completion has a proven original input; it never borrows a newer speaker's route. */
export function nativeJobCompletion(sessionId: string, events: readonly SessionEvent[]) {
  let start=-1
  for(let index=events.length-1;index>=0;index--)if(events[index]!.type==='turn/start'){start=index;break}
  const current = events.slice(start+1)
  if (current.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
  const notices = current.filter(event => event.type === 'user/message' && String(event.data.source.kind) === 'tool-jobs')
  const found: Array<{ origin: NativeJobOrigin; notice: Extract<SessionEvent, { type: 'user/message' }>; input: Extract<SessionEvent, { type: 'user/message' }> }> = []
  for (const notice of notices) {
    if (notice.type !== 'user/message') continue
    const origin=noticeOrigin(sessionId,events,notice.data)
    if (!origin) return
    const input = events.find(event => event.type === 'user/message' && event.data.id === origin.inputId && event.data.source.kind === 'user')
    if (input?.type !== 'user/message') return
    found.push({ origin, notice, input })
  }
  const latest = found.at(-1)
  if (!latest || found.some(item => item.origin.routeId !== latest.origin.routeId || item.origin.userId !== latest.origin.userId)) return
  return { ...latest, jobIds: found.map(item => item.origin.jobId) }
}

export function nativeJobRoute(state: PartnerState, origin: NativeJobOrigin): ChannelSession | undefined {
  const route = state.sessions.find(route => route.id === origin.routeId && route.sessionId === origin.sessionId && route.companionId === origin.owner && route.channelId === origin.channelId && route.userId === origin.userId)
  if (!route || !state.companions.some(companion => companion.id === origin.owner)) return
  if (route.kind === 'local') return route
  const channel = state.channels.find(channel => channel.id === route.channelId && channel.companionId === origin.owner && channel.enabled)
  if (!channel || channel.accountId !== origin.accountId || (channel.direct?.baseUrl ?? '') !== origin.baseUrl || directReplyTarget(state, route.channelId, route.userId) !== origin.targetId || !channelReplyAllowed(state, route.channelId, route.userId)) return
  return route
}
