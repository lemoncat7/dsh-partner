import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14, IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BoardTaskStatusView, type BoardTaskView, type PartnerDirectoryEntryView, type TaskActivityView, type TaskBoardView } from '../client-api.js'

const COLUMNS: Array<{ id: BoardTaskStatusView; label: string }> = [
  { id: 'backlog', label: '收集箱' }, { id: 'ready', label: '待开始' }, { id: 'doing', label: '进行中' },
  { id: 'review', label: '待验收' }, { id: 'blocked', label: '受阻' }, { id: 'done', label: '已完成' },
]
const LIVE_REFRESH_MS = 4_000

export function TaskBoardPanel(): JSX.Element {
  const [board, setBoard] = useState<TaskBoardView>({ tasks: [], activities: [] })
  const [directory, setDirectory] = useState<PartnerDirectoryEntryView[]>([])
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [syncedAt, setSyncedAt] = useState<number>()
  const loadingRef = useRef(false)
  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const [next, collaboration] = await Promise.all([api<TaskBoardView>('/tasks'), api<{ companions: PartnerDirectoryEntryView[] }>('/collaboration')])
      setBoard(next); setDirectory(collaboration.companions); setSyncedAt(Date.now()); setError(undefined)
    } catch (reason) { setError(message(reason)) } finally { loadingRef.current = false }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, LIVE_REFRESH_MS)
    const visible = (): void => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [load])
  const update = async (task: BoardTaskView, change: Record<string, unknown>): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: task.revision, ...change }) }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const delegate = async (task: BoardTaskView): Promise<void> => {
    if (!task.assigneeCompanionId) return
    setBusy(task.id); setError(undefined)
    try {
      await api(`/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ to: task.assigneeCompanionId, request: task.description || `完成任务：${task.title}` }) })
      await load()
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const review = async (task: BoardTaskView): Promise<void> => {
    if (!task.reviewerCompanionId) return
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/review`, { method: 'POST', body: JSON.stringify({ to: task.reviewerCompanionId }) }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const accept = async (task: BoardTaskView): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/accept`, { method: 'POST' }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const reject = async (task: BoardTaskView, reason: string): Promise<void> => {
    if (!reason) return
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); await load() }
    catch (cause) { setError(message(cause)) } finally { setBusy(undefined) }
  }
  const remove = async (task: BoardTaskView): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); if (expandedId === task.id) setExpandedId(undefined); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  return <div className="dsh-partner-feature-page is-board">
    <header className="dsh-partner-feature-hero"><span><small>SHARED WORKSPACE</small><h2>伙伴任务看板</h2><p>多步、依赖、委派或跨会话工作才进入看板。前置任务完成后才能执行，结果经过验收后才会解锁后续任务。</p></span><div><span className="dsh-partner-board-live" title={syncedAt ? `最近同步 ${new Date(syncedAt).toLocaleTimeString()}` : '正在连接'}><i />实时同步</span><button type="button" onClick={() => setCreating(value => !value)}><IconPlusOutline16 size={15} />新任务</button></div></header>
    {error && <p className="dsh-partner-feature-error" role="alert">{error}</p>}
    {creating && <TaskForm companions={directory} tasks={board.tasks} close={() => setCreating(false)} changed={load} />}
    <div className="dsh-partner-board" aria-label="任务看板">{COLUMNS.map(column => {
      const tasks = board.tasks.filter(item => item.status === column.id)
      return <section key={column.id} data-status={column.id}><header><strong>{column.label}</strong><b>{tasks.length}</b></header><div>{tasks.map(task => <TaskCard
        key={task.id} task={task} tasks={board.tasks} activities={board.activities.filter(item => item.taskId === task.id)} directory={directory}
        expanded={expandedId === task.id} busy={busy === task.id} toggle={() => setExpandedId(current => current === task.id ? undefined : task.id)}
        update={change => { void update(task, change) }} delegate={() => { void delegate(task) }} review={() => { void review(task) }}
        accept={() => { void accept(task) }} reject={reason => { void reject(task, reason) }} remove={() => { void remove(task) }}
      />)}</div>{tasks.length === 0 && <p>暂无任务</p>}</section>
    })}</div>
  </div>
}

function TaskCard({ task, tasks, activities, directory, expanded, busy, toggle, update, delegate, review, accept, reject, remove }: {
  task: BoardTaskView; tasks: BoardTaskView[]; activities: TaskActivityView[]; directory: PartnerDirectoryEntryView[]; expanded: boolean; busy: boolean
  toggle(): void; update(change: Record<string, unknown>): void; delegate(): void; review(): void; accept(): void; reject(reason: string): void; remove(): void
}): JSX.Element {
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const byId = useMemo(() => new Map(tasks.map(item => [item.id, item])), [tasks])
  const dependencies = task.dependencyTaskIds.map(id => byId.get(id)).filter((item): item is BoardTaskView => item !== undefined)
  const blockers = dependencies.filter(item => item.status !== 'done')
  const assignee = directory.find(item => item.id === task.assigneeCompanionId)
  const reviewer = directory.find(item => item.id === task.reviewerCompanionId)
  const dependencyCandidates = tasks.filter(item => item.id !== task.id && !task.dependencyTaskIds.includes(item.id) && !dependsOn(item.id, task.id, byId))
  const canExecute = Boolean(task.assigneeCompanionId) && blockers.length === 0 && !['doing', 'review', 'done'].includes(task.status)
  const recentActivities = [...activities].sort((left, right) => right.at - left.at).slice(0, 6)
  return <article className="dsh-partner-task-card" data-expanded={expanded} data-blocked={blockers.length > 0}>
    <span className={`dsh-partner-priority is-${task.priority}`} />
    <button type="button" className="dsh-partner-task-summary" aria-expanded={expanded} onClick={toggle}><span><strong>{task.title}</strong><p>{task.description || '没有补充说明'}</p><small>{assignee ? `@${assignee.name}` : '未指派'} · {dependencies.length ? `${dependencies.length} 项前置${blockers.length ? `，${blockers.length} 项未完成` : '均已完成'}` : '无前置依赖'}{task.resultSummary ? ' · 已有结果' : ''}</small></span><IconChevronDownOutline14 size={14} /></button>
    {expanded && <div className="dsh-partner-task-detail">
      <div className="dsh-partner-task-fields"><label><span>状态</span><select value={task.status} disabled={busy} onChange={event => update({ status: event.target.value })}>{COLUMNS.map(item => <option key={item.id} value={item.id} disabled={(item.id === 'doing' || item.id === 'review' || item.id === 'done') && blockers.length > 0 || item.id === 'done' && task.status !== 'review' && task.status !== 'done'}>{item.label}</option>)}</select></label><label><span>负责人</span><select value={task.assigneeCompanionId ?? ''} disabled={busy || task.status === 'doing'} onChange={event => update({ assigneeCompanionId: event.target.value })}><option value="">未指派</option>{directory.map(item => <option key={item.id} value={item.id} disabled={item.id === task.reviewerCompanionId}>@{item.name} · {item.availability === 'busy' ? '忙碌' : '可用'}</option>)}</select></label><label><span>验收伙伴</span><select value={task.reviewerCompanionId ?? ''} disabled={busy} onChange={event => update({ reviewerCompanionId: event.target.value })}><option value="">留空 · 人工验收</option>{directory.map(item => <option key={item.id} value={item.id} disabled={item.id === task.assigneeCompanionId}>@{item.name}</option>)}</select></label></div>
      <section className="dsh-partner-task-dependency"><header><strong>前置任务</strong><small>{blockers.length ? `${blockers.length} 项未完成，当前任务不能启动` : dependencies.length ? '已全部完成，可以启动' : '没有前置依赖'}</small></header>{dependencies.length > 0 && <div>{dependencies.map(item => <span key={item.id} data-done={item.status === 'done'}><i>{item.status === 'done' ? <IconCheckOutline16 size={12} /> : ''}</i><b>{item.title}</b><button type="button" disabled={busy || ['doing', 'review', 'done'].includes(task.status)} aria-label={`移除前置任务 ${item.title}`} onClick={() => update({ dependencyTaskIds: task.dependencyTaskIds.filter(id => id !== item.id) })}>移除</button></span>)}</div>}{dependencyCandidates.length > 0 && <label><span className="sr-only">增加前置任务</span><select defaultValue="" disabled={busy || ['doing', 'review', 'done'].includes(task.status)} onChange={event => { const id = event.currentTarget.value; if (id) update({ dependencyTaskIds: [...task.dependencyTaskIds, id] }); event.currentTarget.value = '' }}><option value="">增加前置任务…</option>{dependencyCandidates.map(item => <option value={item.id} key={item.id}>{item.title} · {statusLabel(item.status)}</option>)}</select></label>}</section>
      {task.resultSummary && <ResultBlock label="执行结果" value={task.resultSummary} />}
      {task.reviewSummary && <ResultBlock label={`核验意见${reviewer ? ` · @${reviewer.name}` : ''}`} value={task.reviewSummary} />}
      {recentActivities.length > 0 && <section className="dsh-partner-task-activity"><strong>最近活动</strong><ol>{recentActivities.map(item => <li key={item.id}><span>{item.message}</span><time>{new Date(item.at).toLocaleString()}</time></li>)}</ol></section>}
      {rejecting && <form className="dsh-partner-task-reject" onSubmit={event => { event.preventDefault(); const reason = rejectReason.trim(); if (!reason) return; reject(reason); setRejecting(false); setRejectReason('') }}><label><span>打回原因</span><textarea autoFocus value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={3} maxLength={1200} placeholder="说明需要重做或补充的内容" /></label><div><button type="button" onClick={() => { setRejecting(false); setRejectReason('') }}>取消</button><button type="submit" className="is-primary" disabled={busy || !rejectReason.trim()}>确认打回</button></div></form>}
      {confirmingDelete && <div className="dsh-partner-task-delete-confirm" role="alert"><span>删除后，依赖它的任务会解除这条前置关系。</span><div><button type="button" onClick={() => setConfirmingDelete(false)}>取消</button><button type="button" className="is-danger" disabled={busy} onClick={remove}>确认删除</button></div></div>}
      <footer className="dsh-partner-task-actions"><small>r{task.revision} · {new Date(task.updatedAt).toLocaleString()}</small><span>{task.status === 'review' ? <>{task.reviewerCompanionId && <button type="button" disabled={busy} onClick={review}>{busy ? '核验中…' : `交给 @${reviewer?.name ?? '伙伴'} 核验`}</button>}<button type="button" disabled={busy} onClick={() => setRejecting(true)}>打回重做</button><button type="button" className="is-primary" disabled={busy} onClick={accept}>验收通过</button></> : <button type="button" disabled={busy || !canExecute} title={blockers.length ? '前置任务尚未完成' : !task.assigneeCompanionId ? '请先选择负责人' : undefined} onClick={delegate}>{busy ? '执行中…' : task.status === 'doing' ? '正在执行' : task.status === 'done' ? '已经完成' : `交给 @${assignee?.name ?? '伙伴'}`}</button>}<button type="button" className="is-icon" aria-label={`删除 ${task.title}`} aria-expanded={confirmingDelete} disabled={busy} onClick={() => setConfirmingDelete(true)}><IconTrashOutline16 size={14} /></button></span></footer>
    </div>}
  </article>
}

function ResultBlock({ label, value }: { label: string; value: string }): JSX.Element {
  return <section className="dsh-partner-task-result"><strong>{label}</strong><p>{value}</p></section>
}

function TaskForm({ companions, tasks, close, changed }: { companions: PartnerDirectoryEntryView[]; tasks: BoardTaskView[]; close(): void; changed(): Promise<void> }): JSX.Element {
  const [error, setError] = useState<string>()
  const [assignee, setAssignee] = useState('')
  const [reviewer, setReviewer] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({
        title: data.get('title'), description: data.get('description'), priority: data.get('priority'), status: 'backlog',
        assigneeCompanionId: data.get('assignee') || undefined, reviewerCompanionId: data.get('reviewer') || undefined,
        dependencyTaskIds: data.getAll('dependencyTaskId'),
      }) })
      await changed(); close()
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-task-form" onSubmit={event => { void submit(event) }}><label><span>任务名称</span><input name="title" maxLength={200} required autoFocus /></label><label><span>负责人</span><select name="assignee" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">未指派</option>{companions.map(item => <option key={item.id} value={item.id} disabled={item.id === reviewer}>@{item.name}</option>)}</select></label><label className="is-wide"><span>任务说明</span><textarea name="description" maxLength={8000} rows={4} /></label><label><span>优先级</span><select name="priority" defaultValue="normal"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label><label><span>验收伙伴</span><select name="reviewer" value={reviewer} onChange={event => setReviewer(event.target.value)}><option value="">留空 · 人工验收</option>{companions.map(item => <option key={item.id} value={item.id} disabled={item.id === assignee}>@{item.name}</option>)}</select></label>{tasks.length > 0 && <div className="dsh-partner-task-form-dependencies is-wide"><span>前置任务</span><div>{tasks.filter(item => item.status !== 'done').map(item => <label key={item.id}><input type="checkbox" name="dependencyTaskId" value={item.id} /><i /><span>{item.title}</span><small>{statusLabel(item.status)}</small></label>)}</div><small>可多选；这些任务全部完成前，新任务不能启动。</small></div>}<footer><button type="submit"><IconPlusOutline16 size={14} />创建任务</button><button type="button" onClick={close}>取消</button></footer>{error && <p role="alert">{error}</p>}</form>
}

function dependsOn(candidateId: string, targetId: string, tasks: Map<string, BoardTaskView>, visited = new Set<string>()): boolean {
  if (candidateId === targetId) return true
  if (visited.has(candidateId)) return false
  visited.add(candidateId)
  return (tasks.get(candidateId)?.dependencyTaskIds ?? []).some(id => dependsOn(id, targetId, tasks, visited))
}
function statusLabel(value: BoardTaskStatusView): string { return COLUMNS.find(item => item.id === value)?.label ?? value }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
