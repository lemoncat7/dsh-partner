import { useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { workProgressOf, workProgressRunning, workProgressLabel, type WorkProgress } from './work-progress-state.js'

export const workProgressDefinition: ConversationNodeDefinition<WorkProgress> = {
  kind: 'partner-work-progress', target: 'chat',
  match: event => { const p=workProgressOf(event); return p ? {id:p.id,role:'start'} : null },
  start: (_ctx,match)=>workProgressOf(match.event)!,
  update: (_ctx,match)=>workProgressOf(match.event)!,
  buildViewNode: ctx => {
    if (!ctx.state || !ctx.start) return null
    const {location,event}=ctx.start
    const turn=location.kind==='turn'||location.kind==='step'?location.turn:undefined
    const data=turn?.status==='closed'&&workProgressRunning(ctx.state.phase)
      ? {...ctx.state,phase:'interrupted' as const,active:[],endedAt:turn.end?.time??ctx.state.updatedAt} : ctx.state
    return {key:ctx.key,id:ctx.id,kind:'partner-work-progress',target:'chat',anchorSeq:event.seq,location,visibility:'visible',groupTree:'turn',data}
  },
}
export function progressDuration(ms: number): string {
  const seconds=Math.max(0,Math.floor(ms/1000))
  return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`
}
export function WorkProgressCard({data}: {data: WorkProgress}) {
  const running=workProgressRunning(data.phase)
  const [now,setNow]=useState(Date.now)
  useEffect(()=>{if(!running)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[running,data.id])
  const duration=(data.endedAt??now)-data.startedAt, quiet=now-data.updatedAt
  return <section className="dsh-partner-work-progress" aria-label="独立工作进度">
    <div className="dsh-partner-work-progress-heading"><strong>独立工作</strong><span>{running?'已用时':'用时'} {progressDuration(duration)}</span></div>
    <div role="status" aria-live="polite" aria-atomic="true">{workProgressLabel(data)}</div>
    <p>已结束 {data.completed} 次操作{data.catalogue>0?` · 其中 ${data.catalogue} 次目录查询`:''}{data.failed>0?` · ${data.failed} 次失败`:''}</p>
    {running&&quiet>=30000&&<p className="dsh-partner-work-progress-wait">距上次状态变化 {progressDuration(quiet)}，仍在等待返回。</p>}
    {data.active.length>1&&<ul>{data.active.slice(0,4).map(a=><li key={a.id}>{a.label}</li>)}</ul>}
    {data.recent.length>0&&<details><summary>最近操作</summary><ul>{data.recent.map((a,i)=><li key={i}>{a.failed?'失败':'已返回'} · {a.label}</li>)}</ul></details>}
    {!running&&(data.phase==='completed'||data.phase==='partial')&&<small>执行结果已返回主会话，聊天和附件交付以主会话回执为准。</small>}
    {!running&&['failed','canceled','timed-out','interrupted'].includes(data.phase)&&<small>工作已停止；已执行操作不会因停止而自动撤销。</small>}
  </section>
}
export function registerWorkProgressCards(ctx: Context): void {
  const runtime=ctx as unknown as {
    inject(names:string[],callback:(scope:Context)=>void):unknown
    slots:{inject(name:string,callback:()=>unknown):unknown;register(options:{name:string;key:string},render:(props:{node:{data:WorkProgress}})=>JSX.Element):()=>void}
  }
  const registered=new WeakSet<object>()
  const register=(scope:Context,modern:boolean)=>{
    type Registry={register(definition:ConversationNodeDefinition<WorkProgress>):()=>void}
    const registry=modern?scope.get('conversationEvents') as Registry:(scope.get('uiConversation') as {events:Registry}).events
    if(registered.has(registry))return
    registered.add(registry)
    scope.effect(()=>{const dispose=registry.register(workProgressDefinition);return()=>{registered.delete(registry);dispose()}},'partner: work progress')
  }
  runtime.inject(['uiConversation'],scope=>register(scope,false))
  runtime.inject(['conversationEvents'],scope=>register(scope,true))
  runtime.slots.inject('conversation.chat.node',()=>runtime.slots.register({name:'conversation.chat.node',key:'partner-work-progress'},props=><WorkProgressCard data={props.node.data}/>))
}
