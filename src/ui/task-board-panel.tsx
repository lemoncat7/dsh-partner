import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BoardTaskStatusView, type BoardTaskView, type PartnerDirectoryEntryView, type TaskBoardView } from '../client-api.js'

const COLUMNS: Array<{ id: BoardTaskStatusView; label: string }> = [
  { id: 'backlog', label: '收集箱' }, { id: 'ready', label: '待开始' }, { id: 'doing', label: '进行中' },
  { id: 'review', label: '待验收' }, { id: 'blocked', label: '受阻' }, { id: 'done', label: '已完成' },
]

export function TaskBoardPanel(): JSX.Element {
  const [board, setBoard] = useState<TaskBoardView>({ tasks: [], activities: [] })
  const [directory, setDirectory] = useState<PartnerDirectoryEntryView[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try {
      const [next, collaboration] = await Promise.all([api<TaskBoardView>('/tasks'), api<{ companions: PartnerDirectoryEntryView[] }>('/collaboration')])
      setBoard(next); setDirectory(collaboration.companions)
      setError(undefined)
    } catch (reason) { setError(message(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const move = async (task: BoardTaskView, status: BoardTaskStatusView): Promise<void> => {
    setBusy(task.id)
    try { await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: task.revision, status }) }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const assign = async (task: BoardTaskView, assignee: string): Promise<void> => {
    setBusy(task.id)
    try { await api(`/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ expectedRevision: task.revision, assigneeCompanionId: assignee }) }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const delegate = async (task: BoardTaskView): Promise<void> => {
    if (!task.assigneeCompanionId) return
    setBusy(task.id)
    try {
      await api(`/tasks/${task.id}/delegate`, { method: 'POST', body: JSON.stringify({ to: task.assigneeCompanionId, request: task.description || `完成任务：${task.title}` }) })
      await load()
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const remove = async (id: string): Promise<void> => { setBusy(id); try { await api(`/tasks/${id}`, { method: 'DELETE' }); await load() } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) } }
  return <div className="dsh-partner-feature-page is-board">
    <header className="dsh-partner-feature-hero"><span><small>SHARED WORKSPACE</small><h2>伙伴任务看板</h2><p>你可以直接把任务交给任意伙伴；伙伴自主拆解工作时，只能委派给能力页中明确授权的伙伴。</p></span><div><button type="button" onClick={() => { void load() }}><IconRefreshOutline16 size={15} />刷新</button><button type="button" onClick={() => setCreating(true)}><IconPlusOutline16 size={15} />新任务</button></div></header>
    {creating && <TaskForm companions={directory} close={() => setCreating(false)} changed={load} />}
    <div className="dsh-partner-board" aria-label="任务看板">{COLUMNS.map(column => {
      const tasks = board.tasks.filter(item => item.status === column.id)
      return <section key={column.id} data-status={column.id}><header><strong>{column.label}</strong><b>{tasks.length}</b></header><div>{tasks.map(task => <article key={task.id}>
        <span className={`dsh-partner-priority is-${task.priority}`} />
        <strong>{task.title}</strong><p>{task.description || '没有补充说明'}</p>
        <label><span>状态</span><select value={task.status} disabled={busy === task.id} onChange={event => { void move(task, event.target.value as BoardTaskStatusView) }}>{COLUMNS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>负责人</span><select value={task.assigneeCompanionId ?? ''} disabled={busy === task.id} onChange={event => { void assign(task, event.target.value) }}><option value="">未指派</option>{directory.map(item => <option key={item.id} value={item.id}>@{item.name} · {item.availability === 'busy' ? '忙碌' : '可用'}</option>)}</select></label>
        <footer><small>r{task.revision} · {new Date(task.updatedAt).toLocaleDateString()}</small><span>{task.assigneeCompanionId && <button type="button" disabled={busy === task.id} onClick={() => { void delegate(task) }}>{busy === task.id ? '执行中…' : `交给 @${directory.find(item => item.id === task.assigneeCompanionId)?.name ?? '伙伴'}`}</button>}<button type="button" className="is-icon" aria-label={`删除 ${task.title}`} disabled={busy === task.id} onClick={() => { void remove(task.id) }}><IconTrashOutline16 size={14} /></button></span></footer>
      </article>)}</div>{tasks.length === 0 && <p>暂无任务</p>}</section>
    })}</div>
    {error && <p className="dsh-partner-error" role="alert">{error}</p>}
  </div>
}

function TaskForm({ companions, close, changed }: { companions: PartnerDirectoryEntryView[]; close(): void; changed(): Promise<void> }): JSX.Element {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      await api('/tasks', { method: 'POST', body: JSON.stringify({ title: data.get('title'), description: data.get('description'), priority: data.get('priority'), status: 'backlog', assigneeCompanionId: data.get('assignee') || undefined }) })
      await changed(); close()
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-task-form" onSubmit={event => { void submit(event) }}><label><span>任务名称</span><input name="title" maxLength={200} required autoFocus /></label><label><span>任务说明</span><textarea name="description" maxLength={8000} rows={3} /></label><label><span>优先级</span><select name="priority" defaultValue="normal"><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label><label><span>负责人</span><select name="assignee" defaultValue=""><option value="">未指派</option>{companions.map(item => <option key={item.id} value={item.id}>@{item.name}</option>)}</select></label><footer><button type="submit"><IconPlusOutline16 size={14} />创建</button><button type="button" onClick={close}>取消</button></footer>{error && <p role="alert">{error}</p>}</form>
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
