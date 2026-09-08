import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from 'react'
import { IconCheckOutline16, IconChevronRightOutline14, IconCloseOutline16, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BoardTaskStatusView, type BoardTaskView, type PartnerDelegationView, type PartnerDirectoryEntryView, type TaskActivityView, type TaskBoardView } from '../client-api.js'
import { CollectionSkeleton, WorkspaceDialog, WorkspaceHero, WorkspaceNotice, errorMessage } from './workspace-components.js'
import { TaskBoardStage } from './task-board-stage.js'
import { useBoardRefresh } from './board-refresh.js'
import { RequirementDetail, requirementStatus } from './requirement-dialog.js'

const COLUMNS: Array<{ id: BoardTaskStatusView; label: string }> = [
  { id: 'backlog', label: '收集箱' }, { id: 'ready', label: '待开始' }, { id: 'doing', label: '进行中' },
  { id: 'review', label: '待验收' }, { id: 'blocked', label: '受阻' }, { id: 'done', label: '已完成' },
]
type BoardStatusFilter = BoardTaskStatusView | 'all'

export function RequirementTasksPanel({ initialTaskId, openRequest, requirementId, back, detailOnly = false }: { initialTaskId?: string | undefined; openRequest?: object | undefined; requirementId?: string; back?(): void; detailOnly?: boolean } = {}): JSX.Element {
  const [board, setBoard] = useState<TaskBoardView>({ tasks: [], activities: [] })
  const [directory, setDirectory] = useState<PartnerDirectoryEntryView[]>([])
  const [delegations, setDelegations] = useState<PartnerDelegationView[]>([])
  const [creating, setCreating] = useState(false)
  const [requirementDetail, setRequirementDetail] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(initialTaskId)
  useEffect(() => { if (initialTaskId) setSelectedTaskId(initialTaskId) }, [initialTaskId, openRequest])
  const [busy, setBusy] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [syncedAt, setSyncedAt] = useState<number>()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<BoardStatusFilter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())
  const tasksById = useMemo(() => new Map(board.tasks.map(item => [item.id, item])), [board.tasks])
  const directoryById = useMemo(() => new Map(directory.map(item => [item.id, item])), [directory])
  const activeDelegationByTaskId = useMemo(() => {
    const result = new Map<string, PartnerDelegationView>()
    for (const delegation of delegations) {
      if ((delegation.status === 'queued' || delegation.status === 'running') && !result.has(delegation.taskId)) result.set(delegation.taskId, delegation)
    }
    return result
  }, [delegations])
  const selectedTask = selectedTaskId ? tasksById.get(selectedTaskId) : undefined
  const requirement = board.requirements?.find(item => item.id === requirementId)
  const requirementTasks = useMemo(() => board.tasks.filter(task => !requirementId || (requirementId === 'legacy' ? !task.requirementId : task.requirementId === requirementId)), [board.tasks, requirementId])
  const dependentsById = useMemo(() => {
    const result = new Map<string, number>()
    for (const task of board.tasks) for (const dependencyId of task.dependencyTaskIds) result.set(dependencyId, (result.get(dependencyId) ?? 0) + 1)
    return result
  }, [board.tasks])
  const scopedTasks = useMemo(() => requirementTasks.filter(task => {
    if (assigneeFilter !== 'all' && (task.assigneeCompanionId ?? 'unassigned') !== assigneeFilter) return false
    if (!deferredQuery) return true
    const dependencies = task.dependencyTaskIds.map(id => tasksById.get(id)?.title ?? '')
    return [task.title, task.description, task.resultAbstract, task.resultSummary, directoryById.get(task.assigneeCompanionId ?? '')?.name, ...dependencies]
      .some(value => value?.toLocaleLowerCase().includes(deferredQuery))
  }), [assigneeFilter, requirementTasks, deferredQuery, directoryById, tasksById])
  const statusCounts = useMemo(() => {
    const result = new Map<BoardTaskStatusView, number>(COLUMNS.map(column => [column.id, 0]))
    for (const task of scopedTasks) result.set(task.status, (result.get(task.status) ?? 0) + 1)
    return result
  }, [scopedTasks])
  const visibleColumns = statusFilter === 'all' ? COLUMNS.filter(column => (statusCounts.get(column.id) ?? 0) > 0) : COLUMNS.filter(column => column.id === statusFilter)
  const tasksByStatus = useMemo(() => {
    const priorityRank: Record<BoardTaskView['priority'], number> = { urgent: 3, high: 2, normal: 1, low: 0 }
    const result = new Map<BoardTaskStatusView, BoardTaskView[]>(COLUMNS.map(column => [column.id, []]))
    for (const task of scopedTasks) {
      if (statusFilter !== 'all' && task.status !== statusFilter) continue
      result.get(task.status)?.push(task)
    }
    for (const tasks of result.values()) tasks.sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority] || right.updatedAt - left.updatedAt)
    return result
  }, [scopedTasks, statusFilter])
  const visibleTaskCount = statusFilter === 'all' ? scopedTasks.length : (statusCounts.get(statusFilter) ?? 0)
  const load = useBoardRefresh(async () => {
      const [next, collaboration] = await Promise.all([api<TaskBoardView>('/tasks'), api<{ companions: PartnerDirectoryEntryView[]; delegations: PartnerDelegationView[] }>('/collaboration')])
      return () => { setBoard(next); setDirectory(collaboration.companions); setDelegations(collaboration.delegations); setSyncedAt(Date.now()); setLoading(false); setSelectedTaskId(id => next.tasks.some(t => t.id === id) ? id : undefined) }
  }, reason => { setError(errorMessage(reason)); setLoading(false) })
  const update = async (task: BoardTaskView, change: Record<string, unknown>): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: task.revision, ...change }) }); await load() }
    catch (reason) { await load(); setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  const delegate = async (task: BoardTaskView): Promise<void> => {
    if (!task.assigneeCompanionId) return
    setBusy(task.id); setError(undefined)
    try {
      await api(`/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ to: task.assigneeCompanionId, request: task.description || `完成任务：${task.title}` }) })
      await load()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  const review = async (task: BoardTaskView): Promise<void> => {
    if (!task.reviewerCompanionId) return
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/review`, { method: 'POST', body: JSON.stringify({ to: task.reviewerCompanionId }) }); await load() }
    catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  const accept = async (task: BoardTaskView): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/accept`, { method: 'POST', body: JSON.stringify({ expectedRevision: task.revision }) }); await load() }
    catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  const reject = async (task: BoardTaskView, reason: string): Promise<void> => {
    if (!reason) return
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}/reject`, { method: 'POST', body: JSON.stringify({ reason, expectedRevision: task.revision }) }); await load() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(undefined) }
  }
  const remove = async (task: BoardTaskView): Promise<void> => {
    setBusy(task.id); setError(undefined)
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); if (selectedTaskId === task.id) setSelectedTaskId(undefined); await load() }
    catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  return <div className="dsh-partner-feature-page is-board">
    {!detailOnly && <>{back && <nav className="dsh-partner-requirement-breadcrumb"><button type="button" onClick={back}>需求看板</button><IconChevronRightOutline14 size={14} /><span>{requirement?.title ?? '未归类旧任务'}</span></nav>}<WorkspaceHero eyebrow={requirement ? requirementStatus(requirement) : '旧任务'} title={requirement?.title ?? '未归类旧任务'} detail={requirement?.description || '任务按阶段展示，点击查看交付、依赖和执行状态。'} actions={<><span className="dsh-partner-board-live" title={syncedAt ? `最近同步 ${new Date(syncedAt).toLocaleTimeString()}` : '正在连接'}><i />实时同步</span>{requirement && <button type="button" onClick={() => setRequirementDetail(true)}>需求详情</button>}{requirement?.status === 'planning' && <button type="button" onClick={() => setCreating(true)}><IconPlusOutline16 size={15} />新任务</button>}</>} /></>}
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {requirementDetail && requirement && <WorkspaceDialog eyebrow="需求详情" title={requirement.title} detail={requirementStatus(requirement)} close={() => setRequirementDetail(false)} width="wide"><RequirementDetail key={requirement.id} item={requirement} tasks={requirementTasks} directory={directory} changed={load} close={() => setRequirementDetail(false)} /></WorkspaceDialog>}
    {creating && requirement && <WorkspaceDialog title="新建子任务" detail={`所属需求：${requirement.title}`} close={() => setCreating(false)} width="wide"><TaskForm requirementId={requirement.id} companions={directory} tasks={requirementTasks} close={() => setCreating(false)} changed={load} /></WorkspaceDialog>}
    {selectedTask && <WorkspaceDialog eyebrow="TASK DETAIL" title={selectedTask.title} detail={taskDialogSummary(selectedTask, directory)} close={() => setSelectedTaskId(undefined)} width="wide"><TaskDetail
      key={selectedTask.id} task={selectedTask} tasks={board.tasks} activities={board.activities.filter(item => item.taskId === selectedTask.id)} directory={directory}
      execution={activeDelegationByTaskId.get(selectedTask.id)}
      busy={busy === selectedTask.id} update={change => { void update(selectedTask, change) }} delegate={() => { void delegate(selectedTask) }} review={() => { void review(selectedTask) }}
      accept={() => { void accept(selectedTask) }} reject={reason => { void reject(selectedTask, reason) }} remove={() => { void remove(selectedTask) }}
    />{error && <WorkspaceNotice>{error}</WorkspaceNotice>}</WorkspaceDialog>}
    {!detailOnly && (loading ? <CollectionSkeleton rows={6} /> : <>
      <div className="dsh-partner-board-tools">
        <label className="dsh-partner-board-search"><span className="sr-only">搜索任务</span><span aria-hidden="true"><IconSearchOutline16 size={16} /></span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、负责人或前置任务" />{query && <button type="button" onClick={() => setQuery('')} aria-label="清除任务搜索"><IconCloseOutline16 size={14} /></button>}</label>
        <label className="dsh-partner-board-assignee"><span className="sr-only">按负责人筛选</span><select value={assigneeFilter} onChange={event => setAssigneeFilter(event.target.value)}><option value="all">全部伙伴</option><option value="unassigned">未指派</option>{directory.map(item => <option value={item.id} key={item.id}>@{item.name}</option>)}</select></label>
        <label className="dsh-partner-board-assignee is-mobile-stage"><span className="sr-only">按任务阶段筛选</span><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as BoardStatusFilter)}><option value="all">全部阶段 · {scopedTasks.length}</option>{COLUMNS.map(column => <option value={column.id} key={column.id}>{column.label} · {statusCounts.get(column.id) ?? 0}</option>)}</select></label>
        <small aria-live="polite">显示 {visibleTaskCount} / {board.tasks.length}</small>
      </div>
      <nav className="dsh-partner-board-statuses" aria-label="按任务状态筛选"><button type="button" className={statusFilter === 'all' ? 'is-active' : ''} aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}><span>全部</span><b>{scopedTasks.length}</b></button>{COLUMNS.map(column => <button type="button" key={column.id} className={statusFilter === column.id ? 'is-active' : ''} aria-pressed={statusFilter === column.id} onClick={() => setStatusFilter(column.id)}><span>{column.label}</span><b>{statusCounts.get(column.id) ?? 0}</b></button>)}</nav>
      <div className="dsh-partner-board" data-focused={statusFilter !== 'all'} aria-label="任务看板">{visibleColumns.map(column => {
      const tasks = tasksByStatus.get(column.id) ?? []
      return <TaskBoardStage key={column.id} id={column.id} label={column.label} tasks={tasks} focused={statusFilter !== 'all'} filtered={Boolean(query || assigneeFilter !== 'all')} renderTask={task => <TaskCard
        key={task.id} task={task} tasksById={tasksById} directoryById={directoryById} dependentCount={dependentsById.get(task.id) ?? 0}
        execution={activeDelegationByTaskId.get(task.id)}
        open={() => setSelectedTaskId(task.id)}
      />} />
    })}</div>{!scopedTasks.length && <div className="dsh-partner-collection-empty"><strong>{query || assigneeFilter !== 'all' ? '没有匹配的任务' : '还没有子任务'}</strong><p>{requirement?.status === 'planning' ? '添加子任务并安排负责人，完成分工后在需求详情中提交规划。' : '可返回需求看板查看其他需求。'}</p></div>}</>)}
  </div>
}

function TaskCard({ task, tasksById, directoryById, dependentCount, execution, open }: {
  task: BoardTaskView; tasksById: ReadonlyMap<string, BoardTaskView>; directoryById: ReadonlyMap<string, PartnerDirectoryEntryView>; dependentCount: number; execution: PartnerDelegationView | undefined; open(): void
}): JSX.Element {
  const dependencies = task.dependencyTaskIds.map(id => tasksById.get(id)).filter((item): item is BoardTaskView => item !== undefined)
  const blockers = dependencies.filter(item => item.status !== 'done')
  const completedDependencies = dependencies.length - blockers.length
  const assignee = directoryById.get(task.assigneeCompanionId ?? '')
  const executionState = execution ? delegationState(execution, blockers.length) : task.autoRun && task.status === 'ready' ? { label: blockers.length ? '等待前置完成' : '等待调度' } : undefined
  return <article className="dsh-partner-task-card" data-blocked={blockers.length > 0} data-priority={task.priority}>
    <button type="button" className="dsh-partner-task-summary" aria-haspopup="dialog" onClick={open}><span><span className="dsh-partner-task-card-title"><strong title={task.title}>{task.title}</strong><em>{priorityLabel(task.priority)}</em></span><small className="dsh-partner-task-card-owner">{assignee ? `@${assignee.name}` : '未指派'}{task.resultSummary ? ' · 已有结果' : ''}{executionState ? ` · ${executionState.label}` : ''}</small>{(dependencies.length > 0 || dependentCount > 0) && <span className="dsh-partner-task-relations">{dependencies.length > 0 && <small data-blocked={blockers.length > 0}>前置 {completedDependencies}/{dependencies.length}</small>}{dependentCount > 0 && <small>完成后解锁 {dependentCount}</small>}</span>}</span><IconChevronRightOutline14 size={14} /></button>
  </article>
}

function TaskDetail({ task, tasks, activities, directory, execution, busy, update, delegate, review, accept, reject, remove }: {
  task: BoardTaskView; tasks: BoardTaskView[]; activities: TaskActivityView[]; directory: PartnerDirectoryEntryView[]; execution: PartnerDelegationView | undefined; busy: boolean
  update(change: Record<string, unknown>): void; delegate(): void; review(): void; accept(): void; reject(reason: string): void; remove(): void
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
  const canExecute = Boolean(task.assigneeCompanionId) && !execution && !['doing', 'review', 'done'].includes(task.status)
  const recentActivities = [...activities].sort((left, right) => right.at - left.at).slice(0, 6)
  const executionState = execution ? delegationState(execution, blockers.length) : undefined
  return <div className="dsh-partner-task-detail">
      <section className="dsh-partner-task-description"><strong>任务说明</strong><p>{task.description || '没有补充说明'}</p></section>
      <div className="dsh-partner-task-fields"><label><span>状态</span><select value={task.status} disabled={busy} onChange={event => update({ status: event.target.value })}>{COLUMNS.map(item => <option key={item.id} value={item.id} disabled={(item.id === 'doing' || item.id === 'review' || item.id === 'done') && blockers.length > 0 || item.id === 'done' && task.status !== 'review' && task.status !== 'done'}>{item.label}</option>)}</select></label><label><span>负责人</span><select value={task.assigneeCompanionId ?? ''} disabled={busy || task.status === 'doing'} onChange={event => update({ assigneeCompanionId: event.target.value })}><option value="">未指派</option>{directory.map(item => <option key={item.id} value={item.id}>@{item.name} · {item.availability === 'busy' ? '忙碌' : '可用'}</option>)}</select></label><label><span>验收伙伴</span><select value={task.reviewerCompanionId ?? ''} disabled={busy} onChange={event => update({ reviewerCompanionId: event.target.value })}><option value="">留空 · 人工验收</option>{directory.map(item => <option key={item.id} value={item.id}>@{item.name}</option>)}</select></label></div>
      {executionState && <section className="dsh-partner-task-execution" data-state={execution?.status}><i /><span><strong>{executionState.title}</strong><small>{executionState.detail}</small></span></section>}
      <section className="dsh-partner-task-dependency"><header><strong>前置任务</strong><small>{blockers.length ? `${blockers.length} 项未完成，当前任务不能启动` : dependencies.length ? '已全部完成，可以启动' : '没有前置依赖'}</small></header>{dependencies.length > 0 && <div>{dependencies.map(item => <span key={item.id} data-done={item.status === 'done'}><i>{item.status === 'done' ? <IconCheckOutline16 size={12} /> : ''}</i><b>{item.title}</b><button type="button" disabled={busy || ['doing', 'review', 'done'].includes(task.status)} aria-label={`移除前置任务 ${item.title}`} onClick={() => update({ dependencyTaskIds: task.dependencyTaskIds.filter(id => id !== item.id) })}>移除</button></span>)}</div>}{dependencyCandidates.length > 0 && <label><span className="sr-only">增加前置任务</span><select defaultValue="" disabled={busy || ['doing', 'review', 'done'].includes(task.status)} onChange={event => { const id = event.currentTarget.value; if (id) update({ dependencyTaskIds: [...task.dependencyTaskIds, id] }); event.currentTarget.value = '' }}><option value="">增加前置任务…</option>{dependencyCandidates.map(item => <option value={item.id} key={item.id}>{item.title} · {statusLabel(item.status)}</option>)}</select></label>}</section>
      {task.resultSummary && <ResultBlock label="执行结果" value={task.resultSummary} />}
      {task.reviewSummary && <ResultBlock label={`核验意见${reviewer ? ` · @${reviewer.name}` : ''}`} value={task.reviewSummary} />}
      {recentActivities.length > 0 && <details className="dsh-partner-task-activity dsh-partner-requirement-disclosure"><summary>最近活动 · {recentActivities.length}</summary><ol>{recentActivities.map(item => <li key={item.id}><span>{item.message}</span><time>{new Date(item.at).toLocaleString()}</time></li>)}</ol></details>}
      {rejecting && <form className="dsh-partner-task-reject" onSubmit={event => { event.preventDefault(); const reason = rejectReason.trim(); if (!reason) return; reject(reason); setRejecting(false); setRejectReason('') }}><label><span>打回原因</span><textarea autoFocus value={rejectReason} onChange={event => setRejectReason(event.target.value)} rows={3} maxLength={1200} placeholder="说明需要重做或补充的内容" /></label><div><button type="button" onClick={() => { setRejecting(false); setRejectReason('') }}>取消</button><button type="submit" className="is-primary" disabled={busy || !rejectReason.trim()}>确认打回</button></div></form>}
      {confirmingDelete && <div className="dsh-partner-task-delete-confirm" role="alert"><span>删除会取消关联执行，依赖它的未完成任务将暂停。需求需重新确认范围；不能撤销。</span><div><button type="button" onClick={() => setConfirmingDelete(false)}>保留任务</button><button type="button" className="is-danger" disabled={busy} onClick={remove}>确认删除</button></div></div>}
      <footer className="dsh-partner-task-actions"><small>r{task.revision} · {new Date(task.updatedAt).toLocaleString()}</small><span>{task.status === 'review' ? <>{task.reviewerCompanionId && <button type="button" disabled={busy} onClick={review}>{busy ? '核验中…' : `交给 @${reviewer?.name ?? '伙伴'} 核验`}</button>}<button type="button" disabled={busy} onClick={() => setRejecting(true)}>打回重做</button><button type="button" className="is-primary" disabled={busy} onClick={accept}>验收通过</button></> : <button type="button" disabled={busy || !canExecute} title={blockers.length ? '可提前排队，依赖通过验收后自动执行' : !task.assigneeCompanionId ? '请先选择负责人' : undefined} onClick={delegate}>{busy ? '执行中…' : execution?.status === 'queued' ? '已提交，等待执行' : task.status === 'doing' ? '正在执行' : task.status === 'done' ? '已经完成' : `交给 @${assignee?.name ?? '伙伴'}`}</button>}<button type="button" className="is-icon" aria-label={`删除 ${task.title}`} aria-expanded={confirmingDelete} disabled={busy} onClick={() => setConfirmingDelete(true)}><IconTrashOutline16 size={14} /></button></span></footer>
  </div>
}

function ResultBlock({ label, value }: { label: string; value: string }): JSX.Element {
  return <section className="dsh-partner-task-result"><strong>{label}</strong><p>{value}</p></section>
}

function TaskForm({ requirementId, companions, tasks, close, changed }: { requirementId: string; companions: PartnerDirectoryEntryView[]; tasks: BoardTaskView[]; close(): void; changed(): Promise<void> }): JSX.Element {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const dependencyOptions = tasks.filter(item => item.status !== 'done')
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    setBusy(true); setError(undefined)
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({
        requirementId,
        title: data.get('title'), description: data.get('description'), priority: data.get('priority'),
        autoRun: data.get('submission') === 'run' && Boolean(data.get('assignee')),
        assigneeCompanionId: data.get('assignee') || undefined, reviewerCompanionId: data.get('reviewer') || undefined,
        dependencyTaskIds: data.getAll('dependencyTaskId'),
      }) })
      await changed(); close()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <form className="dsh-partner-task-form" aria-busy={busy} onSubmit={event => { void submit(event) }}><label><span>任务名称</span><input name="title" maxLength={200} required autoFocus placeholder="一句话说明交付目标" /></label><label><span>负责人</span><select name="assignee" defaultValue=""><option value="">未指派</option>{companions.map(item => <option key={item.id} value={item.id}>@{item.name}</option>)}</select></label><label className="is-wide"><span>任务说明</span><textarea name="description" maxLength={8000} rows={5} placeholder="补充背景、交付物和完成条件" /></label><label><span>优先级</span><select name="priority" defaultValue="normal"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label><label><span>验收伙伴</span><select name="reviewer" defaultValue=""><option value="">留空 · 人工验收</option>{companions.map(item => <option key={item.id} value={item.id}>@{item.name}</option>)}</select></label><div className="dsh-partner-task-form-dependencies is-wide"><span>依赖任务 <small>可选</small></span>{dependencyOptions.length > 0 ? <div>{dependencyOptions.map(item => <label key={item.id}><input type="checkbox" name="dependencyTaskId" value={item.id} /><i /><span>{item.title}</span><small>{statusLabel(item.status)}</small></label>)}</div> : <p>当前没有可选的未完成任务</p>}<small>可以选择多个；留空表示该任务不依赖其他任务。</small></div><label className="is-wide"><span>创建后执行</span><select name="submission" defaultValue="run"><option value="run">已指定负责人则自动排队，等待依赖完成后执行</option><option value="plan">仅规划，稍后手动提交</option></select></label>{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy}><IconPlusOutline16 size={14} />{busy ? '创建中…' : '创建任务'}</button></footer></form>
}

function dependsOn(candidateId: string, targetId: string, tasks: Map<string, BoardTaskView>, visited = new Set<string>()): boolean {
  if (candidateId === targetId) return true
  if (visited.has(candidateId)) return false
  visited.add(candidateId)
  return (tasks.get(candidateId)?.dependencyTaskIds ?? []).some(id => dependsOn(id, targetId, tasks, visited))
}
function statusLabel(value: BoardTaskStatusView): string { return COLUMNS.find(item => item.id === value)?.label ?? value }
function taskDialogSummary(task: BoardTaskView, directory: PartnerDirectoryEntryView[]): string {
  const assignee = directory.find(item => item.id === task.assigneeCompanionId)
  return `${statusLabel(task.status)} · ${assignee ? `负责人 @${assignee.name}` : '尚未指派负责人'} · ${priorityLabel(task.priority)}`
}
function priorityLabel(value: BoardTaskView['priority']): string { return ({ low: '低优先级', normal: '普通优先级', high: '高优先级', urgent: '紧急' })[value] }
function delegationState(value: PartnerDelegationView, blockers = 0): { label: string; title: string; detail: string } {
  const review = value.kind === 'review'
  if (value.status === 'queued') {
    if ((value.attempts ?? 0) === 0) return blockers
      ? { label: '等待前置完成', title: '任务已提交，等待依赖', detail: `还有 ${blockers} 个前置任务未通过验收；全部完成后自动执行，无需再次指派。` }
      : { label: '排队中', title: '任务已提交', detail: '正在等待可用执行名额，无需再次指派。' }
    const at = value.nextAttemptAt ? new Date(value.nextAttemptAt).toLocaleString() : '稍后'
    return { label: '等待自动恢复', title: review ? '验收将在连接恢复后继续' : '任务将在连接恢复后继续', detail: `${at} 自动重试${value.error ? ` · ${value.error}` : ''}` }
  }
  const recovered = (value.attempts ?? 1) > 1
  return {
    label: recovered ? `第 ${value.attempts} 次恢复中` : review ? '伙伴验收中' : '伙伴执行中',
    title: recovered ? (review ? '正在恢复伙伴验收' : '正在恢复伙伴任务') : review ? '伙伴正在核验结果' : '伙伴正在执行任务',
    detail: recovered ? '会先检查已有产出，避免重复写入或重复发布。' : '执行状态会自动同步，无需手动刷新。',
  }
}
