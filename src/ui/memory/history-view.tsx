import {useEffect, useState} from 'react'
import {api} from '../../client-api.js'
import {CollectionEmpty, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {DailyReflectionDetail} from './memory-cards.js'
import {useMemoryResource} from './use-memory-resource.js'
import {shiftCalendarDay,validCalendarDay} from '../../memory-calendar.js'
import type {HistoryTurn, MemoryTimeline, TimelineDay} from './types.js'

export function HistoryView({base, scopeId}: {base: string; scopeId: string}): JSX.Element {
  const groups=useMemoryResource<Array<{id:string;title:string}>>(base+'/memory/group-history')
  const [selected,setSelected]=useState('')
  const group=groups.data?.find(item=>item.id===selected)
  return <>
    {!!groups.data?.length&&<label className="dsh-partner-history-source">
      <span>记录来源</span>
      <select aria-label="记录来源" value={group?.id??''} onChange={event=>setSelected(event.target.value)}>
        <option value="">归档对话</option>
        {groups.data.map(item=><option value={item.id} key={item.id}>{item.title} · 归属账号</option>)}
      </select>
    </label>}
    {groups.error&&<WorkspaceNotice>{groups.error}</WorkspaceNotice>}
    <HistoryFeed key={group?.id??scopeId} base={base} scopeId={scopeId} group={group?.id}/>
  </>
}

function HistoryFeed({base,scopeId,group}:{base:string;scopeId:string;group:string|undefined}):JSX.Element {
  const [day, setDay] = useState('')
  const [through,setThrough]=useState('')
  const [term, setTerm] = useState('')
  const [query, setQuery] = useState('')
  const params=new URLSearchParams(group?{group,view:'timeline'}:{scopeId})
  if(through)params.set('through',through)
  const timelinePath=base+(group?'/memory/group-history?':'/memory/timeline?')+params
  const timeline = useMemoryResource<MemoryTimeline>(timelinePath,15_000)
  const days = timeline.data?.days ?? []
  const chosen = days.find(item=>item.day===day)
  const count = days.reduce((total,item)=>total+item.turns,0)
  const pending = days.reduce((total,item)=>total+item.pending,0)
  const peak = Math.max(1,...days.map(item=>item.turns))
  const selectDay=(value:string)=>{setDay(value);setTerm('');setQuery('')}
  const first=days[0]?.day,last=days.at(-1)?.day,today=timeline.data?.today
  const move=(end:string)=>{setThrough(end);selectDay('')}
  return <div className="dsh-partner-history">
    <section className="dsh-partner-history-chart" aria-label="最近 28 天归档活动">
      <header><div><h3>交流时间线</h3><small>{first&&last ? (last===today?'近 28 天 · ':'')+shortDate(first)+'—'+shortDate(last)+(first.slice(0,4)===last.slice(0,4)?' · '+last.slice(0,4):'') : '正在读取归档统计'}</small></div><button type="button" disabled={timeline.loading} onClick={()=>{void timeline.reload()}}>刷新</button></header>
      {timeline.error&&<WorkspaceNotice>{timeline.error}</WorkspaceNotice>}
      {timeline.data&&<>
        <div className="dsh-partner-history-calendar-actions">
          <button type="button" aria-label="往前翻 28 天" disabled={!first} onClick={()=>{if(first)move(shiftCalendarDay(first,-1))}}>‹ 上一段</button>
          <button type="button" aria-label="往后翻 28 天" disabled={!last||last===today} onClick={()=>{if(last){const end=shiftCalendarDay(last,28);move(today&&end>=today?'':end)}}}>下一段 ›</button>
          <label><span>跳到日期</span><input type="date" aria-label="跳到日期" value={day||last||''} max={today} onChange={event=>{
            const value=event.target.value
            if(!validCalendarDay(value)||today&&value>today)return
            if(!first||!last||value<first||value>last)setThrough(value===today?'':value)
            selectDay(value)
          }}/></label>
          {through&&<button type="button" onClick={()=>move('')}>回到最近</button>}
        </div>
        <div className="dsh-partner-history-stats">
          <span><strong>{count}</strong> {group?'轮群内交流':'轮归档对话'}</span>
          <span><strong>{days.filter(item=>item.turns>0).length}</strong> 天有交流</span>
          {pending>0&&<span><strong>{pending}</strong> 轮待整理</span>}
        </div>
        <div className="dsh-partner-history-bars" role="group" aria-label="按日期筛选">
          {days.map(item=>{
            const label=item.day+' · '+item.turns+' 轮'+(item.pending?' · '+item.pending+' 轮待整理':'')
            return <button key={item.day} type="button" aria-pressed={day===item.day} aria-label={label} title={label} onClick={()=>selectDay(item.day)}>
              <i aria-hidden="true" data-active={item.turns>0} style={{height: item.turns ? 9+Math.round(27*Math.sqrt(item.turns/peak)) : 2}} />
              <span>{item.day.slice(-2)}</span>
            </button>
          })}
        </div>
      </>}
    </section>
    <div className="dsh-partner-history-toolbar">
      <button type="button" aria-pressed={!day&&!query} onClick={()=>selectDay('')}>全部日期</button>
      {chosen&&<span className="dsh-partner-history-selection">{shortDate(chosen.day)} · {chosen.turns} 轮</span>}
      <form role="search" onSubmit={event=>{event.preventDefault();setDay('');setQuery(term.trim())}}>
        <input aria-label={group?'搜索归属账号对话':'搜索归档对话'} type="search" value={term} onChange={event=>setTerm(event.target.value)} maxLength={300} placeholder={group?'搜索这个群的归属账号对话':'搜索当前范围的归档对话'} />
        <button type="submit">搜索</button>
      </form>
    </div>
    <HistoryRecords key={day+'\0'+query} base={base} scopeId={scopeId} day={day} query={query} timeline={timeline.data} group={group}/>
  </div>
}

function shortDate(day:string):string {
  return Number(day.slice(5,7))+'月'+Number(day.slice(8,10))+'日'
}

function HistoryRecords({base,scopeId,day,query,timeline,group}: {base:string;scopeId:string;day:string;query:string;timeline:MemoryTimeline|undefined;group:string|undefined}): JSX.Element {
  const params=new URLSearchParams(group?{group,view:'records'}:{scopeId})
  if(day)params.set('day',day)
  if(query)params.set('q',query)
  const endpoint=base+(group?'/memory/group-history?':'/memory/history?')
  const latest=useMemoryResource<HistoryTurn[]>(endpoint+params,15_000)
  const [older,setOlder]=useState<HistoryTurn[]>([])
  const [more,setMore]=useState(true)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState<string>()
  const [page,setPage]=useState(0)
  useEffect(()=>{
    if(!page)return
    const cursor=(older.length?older:latest.data)?.at(-1)
    if(!cursor)return
    const controller=new AbortController(), next=new URLSearchParams(params)
    next.set('before',String(cursor.at));next.set('beforeId',cursor.id)
    setLoading(true);setError(undefined)
    void api<HistoryTurn[]>(endpoint+next,{signal:controller.signal}).then(items=>{
      if(controller.signal.aborted)return
      setOlder(existing=>[...existing,...items]);setMore(items.length===30)
    }).catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason))})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[page])
  const turns=[...new Map([...(latest.data??[]),...older].map(item=>[item.id,item])).values()]
  const timeZone=timeline?.timeZone
  const formatDay=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
  const groups=new Map<string,HistoryTurn[]>()
  for(const turn of turns.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id))){
    const date=day||formatDay.format(turn.at)
    const group=groups.get(date)
    if(group) group.push(turn)
    else groups.set(date,[turn])
  }
  if(day&&!groups.size)groups.set(day,[])
  const days=new Map(timeline?.days.map(item=>[item.day,item]))
  return <div className="dsh-partner-memory-records">
    {query&&<p className="dsh-partner-memory-hint">{'「'+query+'」的相关记录，最多显示 12 条。'}</p>}
    {(error||latest.error)&&<WorkspaceNotice>{error||latest.error}</WorkspaceNotice>}
    {!groups.size&&<CollectionEmpty title={latest.loading?'正在读取历史':'暂无匹配的历史记录'}/>}
    {!!groups.size&&<ol className="dsh-partner-history-days" aria-label="归档对话时间线">
      {[...groups].map(([date,items])=><HistoryDay key={date} date={date} turns={items} info={query?undefined:days.get(date)} timeZone={timeZone} loading={latest.loading}/>)}
    </ol>}
    {!query&&more&&latest.data?.length===30&&<button type="button" disabled={loading||latest.loading} onClick={()=>setPage(value=>value+1)}>{loading?'读取中…':error?'重试读取':'加载更早的对话'}</button>}
  </div>
}

function HistoryDay({date,turns,info,timeZone,loading}: {date:string;turns:HistoryTurn[];info:TimelineDay|undefined;timeZone:string|undefined;loading:boolean}) {
  const weekday=new Date(date+'T00:00:00Z').toLocaleDateString('zh-CN',{timeZone:'UTC',weekday:'long'})
  return <li className="dsh-partner-history-day">
    <header><h3><time dateTime={date}>{shortDate(date)}</time></h3><span>{weekday}</span>
      <small>{info ? info.turns+' 轮交流' : turns.length+' 条记录'}{info?.reviewed?' · 已整理':info?.reviewError?' · 待重试':info?.pending?' · 待整理':''}</small>
    </header>
    {info?.reviewError&&<WorkspaceNotice>{info.reviewError}</WorkspaceNotice>}
    {info?.reflection&&<details className="dsh-partner-memory-record dsh-partner-history-recap">
      <summary><strong>当日回顾</strong><p>{info.reflection.summary}</p></summary>
      <div><DailyReflectionDetail entry={info.reflection}/></div>
    </details>}
    {!!turns.length&&<div className="dsh-partner-history-turns">{turns.map(turn=><HistoryRecord key={turn.id} turn={turn} timeZone={timeZone}/>)}</div>}
    {!turns.length&&<p className="dsh-partner-memory-hint">{loading?'正在读取对话':'当天暂无归档对话'}</p>}
  </li>
}

function HistoryRecord({turn,timeZone}: {turn:HistoryTurn;timeZone:string|undefined}): JSX.Element {
  const [open,setOpen]=useState(false)
  return <details className="dsh-partner-memory-record" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary><time dateTime={new Date(turn.at).toISOString()}>{new Date(turn.at).toLocaleTimeString('zh-CN',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}</time><strong>{turn.user.slice(0,120)}</strong></summary>
    {open&&<div><h3>{turn.accountId?'归属账号 '+turn.accountId:'用户原话'}</h3><p>{turn.user}</p><h3>助手当时的回答</h3><p>{turn.assistant||'这条没有记录到回复。'}</p></div>}
  </details>
}
