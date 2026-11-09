import {summarizeActivities,activitySharingLabel} from '../character/activity-summary.js'
import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { errorMessage } from './workspace-components.js'

export function ThoughtsPanel({companionId}:{companionId:string}):JSX.Element {
  const [snapshot,setSnapshot]=useState<PartnerSnapshot>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0)
  useEffect(()=>{
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const data=await loadPartner();if(alive){setSnapshot(data);setError('')}}catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companionId,revision])
  const [visible,setVisible]=useState(8)
  useEffect(()=>setVisible(8),[companionId])
  const plan=snapshot?.companions.find(c=>c.id===companionId)?.activityPlan
  const journal=[...(snapshot?.companions.find(c=>c.id===companionId)?.activityJournal??[])].reverse()
  const stats=summarizeActivities(journal)
  const thoughts=[...(snapshot?.companions.find(c=>c.id===companionId)?.thoughts??[])].sort((a,b)=>b.updatedAt-a.updatedAt)
  const label=(id:string)=>{
    const route=snapshot?.sessions.find(r=>r.id===id)
    if(!route)return '原会话已移除'
    if(route.kind==='local')return '网页主会话'
    const group=route.userId.match(/^group:(\d+):/)
    return group?`群 ${group[1]}`:`${snapshot?.channels.find(c=>c.id===route.channelId)?.name??'渠道'} · ${snapshot?.pairings.find(p=>p.channelId===route.channelId&&p.userId===route.userId)?.displayName??route.userId}`
  }
  return <section className="dsh-partner-memory-record" aria-label="自主活动记录">
    <h3>自主活动记录</h3>
    <div className="dsh-partner-character-fields">
      <p className="dsh-partner-character-hint">从真实互动或自主活动中形成，由伙伴决定继续、换个会话聊，或放下。念头不是已发生的事实。</p>
      {plan&&<p className="dsh-partner-character-hint" style={{overflowWrap:'anywhere'}}>下一步：{plan.intention}<br/>{label(plan.targetRouteId)} · {{waiting:'等待本轮完成',pending:'等待唤起',claimed:'已唤起',cancelled:'已取消'}[plan.status]}{plan.status==='pending'?` · ${new Date(plan.dueAt).toLocaleString()}`:''}</p>}
      {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
      {!snapshot&&loading&&<p role="status">正在读取…</p>}
      {snapshot&&!thoughts.length&&<p className="dsh-partner-character-hint">暂时没有留下念头，不要求每次互动都产生。</p>}
      {snapshot&&<p className="dsh-partner-character-hint">最近保留 {stats.total} 轮 · 已确认发送 {stats.confirmed} 轮 · 待确认 {stats.pending} 轮 · 含失败操作 {stats.failed} 轮{stats.unknown?` · 历史发送状态未知 ${stats.unknown} 轮`:''}<br/>各类型可重叠：{stats.categories.map(c=>`${c.name} ${c.count}`).join(' · ')||'暂无操作记录'}。仅统计最近保留记录，不代表全部历史。</p>}
      {snapshot&&!journal.length&&<p>暂时没有自主活动记录。</p>}
      <div aria-label="活动时间线">{journal.slice(0,visible).map(a=><article key={a.sessionId+':'+a.id} className="dsh-partner-memory-record" style={{overflowWrap:'anywhere'}}>
        <small>{new Date(a.at).toLocaleString()} · {activitySharingLabel(a)}{a.tools.some(t=>!t.ok)?' · 有操作失败':''}</small>
        <p>{a.summary}</p>
        {a.artifacts.map(path=><p key={path}><small>作品：{path}{journal.filter(r=>r.artifacts.includes(path)).length>1?` · 关联 ${journal.filter(r=>r.artifacts.includes(path)).length} 轮进展`:''}</small><button type="button" onClick={()=>{void navigator.clipboard.writeText(path).catch(()=>setError('复制失败，请手动选择路径复制'))}}>复制路径</button></p>)}
        <details><summary>执行依据</summary><p>{a.silent?'本轮以安静结束工具收尾；之前可能已发送。':'本轮已结束。'}发送状态仅依据已记录回执，不将工具调用当作收件成功。</p><p>{a.tools.map(t=>t.name+(t.ok?' ✓':' ×')).join('、')||'未记录工具操作'}</p></details>
      </article>)}</div>
      {visible<journal.length&&<button type="button" onClick={()=>setVisible(v=>v+8)}>查看更多活动</button>}
      <details><summary>还惦记着什么（{thoughts.filter(t=>t.status==='open').length}）</summary>
      {thoughts.map(t=><details key={t.id} className="dsh-partner-memory-record">
        <summary><span style={{whiteSpace:'normal',overflowWrap:'anywhere'}}>{t.text}</span><small>{t.status==='done'?'已完成（自主标记）':t.status==='dismissed'?'已放下':t.lastOutcome?{considered:'已考虑',silent:'暂时安静',delivered:'已发送',failed:'未确认送达'}[t.lastOutcome]:'还惦记着'}</small></summary>
        <div className="dsh-partner-character-fields"><p>{t.why}</p><small>来自：{t.sourceRouteIds.map(label).join('、')} · {new Date(t.sourceAt).toLocaleString()}</small><small>想去：{label(t.targetRouteId)}</small>{t.result&&<p>{t.result}</p>}<details><summary>来源依据</summary><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{t.evidence}</p></details></div>
      </details>)}
      </details>
      <button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>{loading?'读取中…':'刷新活动'}</button>
    </div>
  </section>
}
