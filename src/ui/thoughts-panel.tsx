import activityCss from './activity-records.css'
import { summarizeActivities, activitySharingLabel } from '../character/activity-summary.js'
import { MAX_ACTIVE_THOUGHTS } from '../character/thought-budget.js'
import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { errorMessage } from './workspace-components.js'

export function ThoughtsPanel({ companionId }: { companionId: string }): JSX.Element {
  // Remount on identity changes: never display another companion's cached records.
  return <><style>{activityCss}</style><ActivityRecords key={companionId} companionId={companionId}/></>
}
function ActivityRecords({ companionId }: { companionId: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<PartnerSnapshot>(), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const [view, setView] = useState<'activities' | 'thoughts'>('activities')
  const [visible, setVisible] = useState(6), [archivedVisible, setArchivedVisible] = useState(6)
  const [copied, setCopied] = useState('')
  useEffect(() => {
    let alive = true, running = false
    const refresh = async () => {
      if (running || document.hidden) return
      running = true; setLoading(true)
      try { const data = await loadPartner(); if (alive) { setSnapshot(data); setError('') } }
      catch (e) { if (alive) setError(errorMessage(e)) }
      finally { running = false; if (alive) setLoading(false) }
    }
    const onVisible = () => { if (!document.hidden) void refresh() }
    void refresh(); const timer = setInterval(() => void refresh(), 30000)
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [companionId, revision])
  const companion = snapshot?.companions.find(c => c.id === companionId)
  const plan = companion?.activityPlan
  const journal = [...(companion?.activityJournal ?? [])].reverse()
  const stats = summarizeActivities(journal)
  const thoughts = [...(companion?.thoughts ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const open = thoughts.filter(t => t.status === 'open'), archived = thoughts.filter(t => t.status !== 'open')
  const date = (at: number) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const label = (id: string) => {
    const route = snapshot?.sessions.find(r => r.id === id)
    if (!route) return '原会话已移除'
    if (route.kind === 'local') return '网页主会话'
    const group = route.userId.match(/^group:(\d+):/)
    return group ? `群 ${group[1]}` : `${snapshot?.channels.find(c => c.id === route.channelId)?.name ?? '渠道'} · ${snapshot?.pairings.find(p => p.channelId === route.channelId && p.userId === route.userId)?.displayName ?? route.userId}`
  }
  const thoughtRow = (t: typeof thoughts[number]) => <details key={t.id} className="dsh-partner-activity-row">
    <summary><span className="dsh-partner-activity-copy">{t.text}</span><small>{t.status === 'done' ? '已完成（自主标记）' : t.status === 'dismissed' ? t.capacityArchivedAt ? '容量整理 · 已放下' : '已放下' : '惦记中'}</small></summary>
    <div className="dsh-partner-activity-detail">
      <p>{t.why}</p><small>来自 {t.sourceRouteIds.map(label).join('、')} · {date(t.sourceAt)}</small>
      <small>想去 {label(t.targetRouteId)}{t.lastOutcome ? ` · ${{ considered: '已考虑', silent: '暂时安静', delivered: '已发送', failed: '未确认送达' }[t.lastOutcome]}` : ''}</small>
      {t.capacityArchivedAt && <p>达到 {MAX_ACTIVE_THOUGHTS} 条上限后自动放下，不表示已经完成。</p>}
      {t.result && <p>{t.result}</p>}
      <details><summary>来源原文</summary><p className="dsh-partner-activity-evidence">{t.evidence}</p></details>
    </div>
  </details>
  return <section className="dsh-partner-activity-board" aria-label="自主活动记录">
    <div className="dsh-partner-activity-toolbar">
      <div className="dsh-partner-activity-switcher" role="group" aria-label="记录类型">
        <button type="button" aria-pressed={view === 'activities'} onClick={() => setView('activities')}>最近活动{snapshot && <span>{journal.length}</span>}</button>
        <button type="button" aria-pressed={view === 'thoughts'} onClick={() => setView('thoughts')}>惦记的事{snapshot && <span>{open.length}/{MAX_ACTIVE_THOUGHTS}</span>}</button>
      </div>
      <button type="button" className="dsh-partner-activity-refresh" disabled={loading} onClick={() => setRevision(n => n + 1)}>{loading ? '读取中…' : '刷新'}</button>
    </div>
    {error && <p role="alert" className="dsh-partner-inline-error">{error}{snapshot ? '（暂时显示上次读取的记录）' : ''}</p>}
    {!snapshot && loading && <p role="status" className="dsh-partner-activity-empty">正在读取活动记录…</p>}
    {snapshot && view === 'activities' && <>
      {plan && plan.status !== 'cancelled' && <div className="dsh-partner-activity-plan"><small>下一步 · {{ waiting: '等本轮结束', pending: '等待唤起', claimed: '已唤起' }[plan.status]}</small><p>{plan.intention}</p><small>{label(plan.targetRouteId)}{plan.status === 'pending' ? ` · ${date(plan.dueAt)}` : ''}</small></div>}
      <div className="dsh-partner-activity-overview"><span>确认发送 <b>{stats.confirmed}</b></span><span>待确认 <b>{stats.pending}</b></span><span data-warning={stats.failed > 0}>含失败操作 <b>{stats.failed}</b></span></div>
      {!journal.length && <p className="dsh-partner-activity-empty">还没有自主活动。唤起后也可以选择安静待着。</p>}
      <div aria-label="活动时间线">{journal.slice(0, visible).map(a => <details key={a.sessionId + ':' + a.id} className="dsh-partner-activity-row">
        <summary><span className="dsh-partner-activity-meta"><time dateTime={new Date(a.at).toISOString()}>{date(a.at)}</time><span>{activitySharingLabel(a)}</span>{a.tools.some(t => !t.ok) && <span className="dsh-partner-activity-warning">有操作失败</span>}</span><span className="dsh-partner-activity-copy">{a.summary}</span><small>{a.artifacts.length ? `${a.artifacts.length} 项作品 · ` : ''}展开详情</small></summary>
        <div className="dsh-partner-activity-detail">
          {a.artifacts.map(path => <div className="dsh-partner-activity-artifact" key={path}><span title={path}>{path}</span><button type="button" onClick={() => { void navigator.clipboard.writeText(path).then(() => setCopied(path)).catch(() => setError('复制失败，请手动选择路径复制')) }}>复制路径</button></div>)}
          <details><summary>执行依据 · {a.tools.length} 项操作</summary><p>{a.silent ? '以安静结束收尾；此前可能已发送。' : '本轮已结束。'}发送状态仅依据实际回执。</p><ul>{a.tools.map((t, i) => <li key={i}>{t.name} · {t.ok ? '成功' : '失败'}</li>)}</ul>{!a.tools.length && <p>未记录工具操作。</p>}</details>
        </div>
      </details>)}</div>
      {visible < journal.length && <button type="button" className="dsh-partner-activity-more" onClick={() => setVisible(v => v + 6)}>查看更多活动（还有 {journal.length - visible} 轮）</button>}
      <details className="dsh-partner-activity-footnote"><summary>统计范围与活动类型</summary><p>仅统计最近保留的 {stats.total} 轮；类型可重叠，不代表全部历史。{stats.unknown ? `其中 ${stats.unknown} 轮的历史发送状态未知。` : ''}</p><p>{stats.categories.map(c => `${c.name} ${c.count}`).join(' · ') || '暂无操作记录'}</p></details>
    </>}
    {snapshot && view === 'thoughts' && <>
      <p className="dsh-partner-activity-note">最多同时惦记 {MAX_ACTIVE_THOUGHTS} 件事，所有会话共用。满额时优先保留正在做、已安排和较新的念头，旧念头放下后仍可查看近期记录。</p>
      {!open.length && <p className="dsh-partner-activity-empty">暂时没有惦记的事，不要求每次互动都留下念头。</p>}
      <div aria-label="当前念头">{open.map(thoughtRow)}</div>
      {archived.length > 0 && <details className="dsh-partner-activity-archive"><summary>已完成与已放下 · {archived.length}</summary>{archived.slice(0, archivedVisible).map(thoughtRow)}{archivedVisible < archived.length && <button type="button" className="dsh-partner-activity-more" onClick={() => setArchivedVisible(n => n + 6)}>查看更多旧念头</button>}<p className="dsh-partner-activity-note">仅保留近期记录；放下的念头不再进入当前活动上下文。</p></details>}
    </>}
    <span className="dsh-partner-activity-copy-status" role="status">{copied ? '路径已复制' : ''}</span>
  </section>
}
