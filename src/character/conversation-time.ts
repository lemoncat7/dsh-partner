import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelSession} from '../domain.js'
import {questionOrigin} from '../channels/question-origin.js'
import {isInternalTaskNotice} from '../channels/delivery-policy.js'
import {isIdleContactNotice} from './idle-contact.js'
import {chatReplyFromEvent} from '../chat/protocol.js'

const valid=(value:number,now:number)=>Number.isFinite(value)&&value>0&&value<=now
const elapsed=(ms:number)=>ms<1000?'不足 1 秒':ms<60000?`${Math.floor(ms/1000)} 秒`:ms<3600000?`${Math.floor(ms/60000)} 分钟 ${Math.floor(ms%60000/1000)} 秒`:ms<86400000?`${Math.floor(ms/3600000)} 小时 ${Math.floor(ms%3600000/60000)} 分钟`:`${Math.floor(ms/86400000)} 天 ${Math.floor(ms%86400000/3600000)} 小时`
/** Bounded factual projection of native events, never a second transcript or a shared-route lastMessageAt. */
export function renderConversationTime(sessionId:string,events:readonly SessionEvent[],routes:readonly ChannelSession[],timeZone:string='Asia/Shanghai',now=Date.now()):string {
  let format:Intl.DateTimeFormat
  try {format=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'})}
  catch {timeZone='UTC';format=new Intl.DateTimeFormat('zh-CN',{timeZone,dateStyle:'full',timeStyle:'short'})}
  const stamp=(at:number)=>`${format.format(at)}（距现在 ${elapsed(now-at)}）`
  const recent=events.slice(-6000)
  const origin=[...recent].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)))
  const autonomous=!!origin&&isIdleContactNotice(origin)
  const route=autonomous&&origin?.type==='user/message'?routes.find(r=>r.sessionId===sessionId&&r.idleContactState?.messageId===origin.data.id):origin&&isInternalTaskNotice(origin)?undefined:questionOrigin(sessionId,recent,routes)
  const local=!autonomous&&origin?.type==='user/message'&&origin.data.source.kind==='user'&&!route&&routes.some(r=>r.sessionId===sessionId&&r.kind==='local')
  const ids=new Set(route?.inboundMessageIds??[])
  const sharedWithChannel=routes.some(r=>r.sessionId===sessionId&&r.kind==='channel')
  const users=recent.filter(e=>e.type==='user/message'&&e.data.source.kind==='user'&&valid(e.time,now)&&(route?ids.has(e.data.id):local&&(!sharedWithChannel||origin?.type==='user/message'&&e.data.id===origin.data.id)))
  const lines=[`【交流时间 · 程序记录】当前 ${format.format(now)}；时区 ${timeZone}。`]
  const latest=users.at(-1),previous=users.at(-2)
  if(latest){
    lines.push(`${autonomous?'当前活动对象最近一次消息':'当前对象最近一条消息'}进入会话：${stamp(latest.time)}。`)
    if(previous)lines.push(`该对象上一条消息：${stamp(previous.time)}；两条消息间隔 ${elapsed(Math.max(0,latest.time-previous.time))}。`)
  }else lines.push('当前对象的交流时间缺少可核验记录，不推测离开多久。')
  if(route){
    const reply=[...recent].reverse().find(e=>{const r=chatReplyFromEvent(e);return r?.originRouteId===route.id&&r.delivered===true&&!r.silent&&valid(e.time,now)})
    if(reply)lines.push(`最近一次有送达确认的回复：${stamp(reply.time)}。`)
  }
  if(latest&&previous){
    const gap=latest.time-previous.time
    if(gap>=0&&gap<=30000)lines.push('交流节奏：对方正在短时间连续接话。将补充、纠正和追问接到同一段交流里；已有新消息时先理解新消息，不逐条补答旧句。')
    else if(gap>=30*60000)lines.push('交流节奏：两条输入之间已有明显间隔。重新结合当前时间和新消息判断话题，过时的招呼、情绪和计划不能直接续上。')
  }
  lines.push('上下文相邻不代表时间相邻。结合真实间隔、当前时段、人物设定和对话判断是否续话、是否仍适合打扰；不要机械报时、固定问候或替对方编造这段时间的经历。历史的“刚才、今晚、等会儿”以当时消息时间为准；临时约定按其期限判断，已过时的计划先核实，不当作刚收到的任务。“稍后再说”不等于已创建定时任务。')
  return lines.join('\n')
}
