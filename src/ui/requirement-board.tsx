import { useEffect, useMemo, useState } from 'react'
import { IconChevronRightOutline14, IconPlusOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type TaskBoardView, type PartnerDirectoryEntryView, type RequirementView } from '../client-api.js'
import { CollectionSkeleton, WorkspaceDialog, WorkspaceHero, WorkspaceNotice, errorMessage } from './workspace-components.js'
import { useBoardRefresh } from './board-refresh.js'
import { RequirementForm, RequirementDetail, requirementStatus } from './requirement-dialog.js'
import { RequirementTasksPanel } from './requirement-tasks-panel.js'

export function RequirementBoard({ initialTaskId, openRequest }: { initialTaskId?: string | undefined; openRequest?: object | undefined } = {}): JSX.Element {
  const [board, setBoard] = useState<TaskBoardView>({ tasks: [], activities: [], requirements: [] })
  const [directory, setDirectory] = useState<PartnerDirectoryEntryView[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>(), [detailId, setDetailId] = useState<string>()
  const [creating, setCreating] = useState(false), [archived, setArchived] = useState(false)
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(24)
  useEffect(() => { if (initialTaskId) { setSelected(undefined); setDetailId(undefined); setCreating(false) } }, [initialTaskId, openRequest])
  const load = useBoardRefresh(async () => {
    const [next, collaboration] = await Promise.all([api<TaskBoardView>('/tasks'), api<{ companions: PartnerDirectoryEntryView[] }>('/collaboration')])
    return () => { setBoard(next); setDirectory(collaboration.companions); setLoading(false); setError(undefined); setDetailId(id => next.requirements?.some(r => r.id === id) ? id : undefined) }
  }, reason => { setError(errorMessage(reason)); setLoading(false) }, !selected)
  const requirements = board.requirements ?? []
  const groups = useMemo(() => {
    const result = new Map<string, TaskBoardView['tasks']>()
    for (const task of board.tasks) { const id = task.requirementId ?? 'legacy'; const group = result.get(id) ?? []; group.push(task); result.set(id, group) }
    return result
  }, [board.tasks])
  const visible = requirements.filter(r => (r.status === 'done') === archived && [r.title, r.description, directory.find(c => c.id === r.ownerCompanionId)?.name].some(v => v?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).sort((a, b) => b.updatedAt - a.updatedAt)
  const detail = requirements.find(r => r.id === detailId)
  if (selected) return <RequirementTasksPanel key={selected} requirementId={selected} back={() => { setSelected(undefined); void load() }} />
  return <div className="dsh-partner-feature-page is-board">
    <WorkspaceHero eyebrow="Shared workspace" title="需求看板" detail="按需求组织工作，子任务独立推进，整体完成后统一汇总。" actions={<button type="button" onClick={() => setCreating(true)}><IconPlusOutline16 size={15} />新需求</button>} />
    {error && <WorkspaceNotice>{error}<button type="button" onClick={() => { void load() }}>重试</button></WorkspaceNotice>}
    <div className="dsh-partner-requirement-toolbar">
      <nav className="dsh-partner-board-statuses" aria-label="需求范围">{[false, true].map(value => <button type="button" key={String(value)} aria-pressed={archived === value} className={archived === value ? 'is-active' : ''} onClick={() => { setArchived(value); setLimit(24) }}>{value ? '已归档' : '进行中'}<b>{requirements.filter(r => (r.status === 'done') === value).length}</b></button>)}</nav>
      <label className="dsh-partner-board-search"><span className="sr-only">搜索需求</span><span aria-hidden="true"><IconSearchOutline16 size={16} /></span><input placeholder="搜索需求或负责人" value={query} onChange={event => { setQuery(event.target.value); setLimit(24) }} /></label>
    </div>
    {loading ? <CollectionSkeleton rows={4} /> : <>
      <div className="dsh-partner-requirement-grid">{visible.slice(0, limit).map(item => {
        const tasks = groups.get(item.id) ?? [], total = item.status === 'done' ? (item.results?.length ?? tasks.length) : tasks.length
        const done = item.status === 'done' ? total : tasks.filter(t => t.status === 'done').length
        const blocked = tasks.filter(t => t.status === 'blocked').length
        return <article key={item.id} className="dsh-partner-requirement-card">
          <button type="button" className="dsh-partner-requirement-open" onClick={() => item.status === 'done' ? setDetailId(item.id) : setSelected(item.id)}>
            <span className="dsh-partner-requirement-meta"><span>{requirementStatus(item)}</span><small>{directory.find(c => c.id === item.ownerCompanionId)?.name ?? '人工收尾'}</small></span>
            <strong title={item.title}>{item.title}</strong><p>{item.summary || item.description || '尚未补充需求说明'}</p>
            <span className="dsh-partner-requirement-progress" role="progressbar" aria-label="子任务验收进度" aria-valuemin={0} aria-valuemax={Math.max(total, 1)} aria-valuenow={done}><i style={{ width: `${total ? done / total * 100 : 0}%` }} /></span>
            <span className="dsh-partner-requirement-meta"><small>{done} / {total} 已验收{blocked ? ` · ${blocked} 受阻` : ''}</small><IconChevronRightOutline14 size={14} /></span>
          </button>
          <footer><small>{new Date(item.updatedAt).toLocaleDateString()} 更新</small><button type="button" onClick={() => setDetailId(item.id)} aria-haspopup="dialog">{item.lastError ? '查看异常' : '需求详情'}</button></footer>
        </article>
      })}</div>
      {!visible.length && <div className="dsh-partner-collection-empty"><strong>{query ? '没有匹配的需求' : archived ? '还没有归档需求' : '从一个需求开始'}</strong><p>{archived ? '子任务全部验收通过、完成总结后，会出现在这里。' : '先写清交付目标，再安排负责人和子任务。'}</p></div>}
      {visible.length > limit && <button type="button" onClick={() => setLimit(n => n + 24)}>显示更多需求 · 还有 {visible.length - limit} 项</button>}
      {!archived && Boolean(groups.get('legacy')?.length) && <button type="button" className="dsh-partner-requirement-legacy" onClick={() => setSelected('legacy')}>未归类旧任务 <b>{groups.get('legacy')!.length}</b><span>保留原记录，不自动合并</span><IconChevronRightOutline14 size={14} /></button>}
    </>}
    {creating && <WorkspaceDialog title="新建需求" detail="一个需求对应一份最终交付，由负责人统一收尾。" close={() => setCreating(false)}><RequirementForm directory={directory} close={() => setCreating(false)} created={async (item: RequirementView) => { setCreating(false); await load(); setSelected(item.id) }} /></WorkspaceDialog>}
    {detail && <WorkspaceDialog title={detail.title} eyebrow="需求详情" detail={requirementStatus(detail)} close={() => setDetailId(undefined)} width="wide"><RequirementDetail key={detail.id} item={detail} tasks={groups.get(detail.id) ?? []} directory={directory} changed={load} close={() => setDetailId(undefined)} /></WorkspaceDialog>}
    {initialTaskId && <RequirementTasksPanel initialTaskId={initialTaskId} openRequest={openRequest} detailOnly />}
  </div>
}
