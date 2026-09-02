import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlayOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView, type ExecutionRunView, type ScheduledTaskView } from '../client-api.js'
import { CollectionEmpty, CollectionSkeleton, WorkspaceBlock, WorkspaceDialog, WorkspaceHero, WorkspaceNotice, errorMessage } from './workspace-components.js'

export function SchedulePanel({ companions }: { companions: CompanionView[] }): JSX.Element {
  const [schedules, setSchedules] = useState<ScheduledTaskView[]>([])
  const [runs, setRuns] = useState<ExecutionRunView[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try { const value = await api<{ schedules: ScheduledTaskView[]; runs: ExecutionRunView[] }>('/schedules'); setSchedules(value.schedules); setRuns(value.runs.filter(item => item.kind === 'schedule').slice(-50).reverse()); setError(undefined) }
    catch (reason) { setError(errorMessage(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const update = async (entry: ScheduledTaskView, value: Record<string, unknown>): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}`, { method: 'PUT', body: JSON.stringify(value) }); await load() } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) } }
  const run = async (entry: ScheduledTaskView): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}/trigger`, { method: 'POST' }); await load() } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) } }
  const remove = async (entry: ScheduledTaskView): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}`, { method: 'DELETE' }); await load() } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) } }
  return <div className="dsh-partner-feature-page">
    <WorkspaceHero eyebrow="Ephemeral automation" title="伙伴定时任务" detail="由指定伙伴在隔离临时会话中执行；默认完成即销毁，避免长期会话被后台任务污染。" actions={<><button type="button" disabled={loading} onClick={() => { void load() }}><IconRefreshOutline16 size={15} />刷新</button><button type="button" disabled={companions.length === 0} onClick={() => setCreating(true)}><IconPlusOutline16 size={15} />新计划</button></>} />
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {creating && <WorkspaceDialog title="新建定时任务" detail="选择执行伙伴、运行频率和会话保留策略。计划创建后可以随时停用或立即执行。" close={() => setCreating(false)} width="wide"><ScheduleForm companions={companions} close={() => setCreating(false)} changed={load} /></WorkspaceDialog>}
    <WorkspaceBlock title="执行计划" detail={`${schedules.filter(item => item.enabled).length} 个启用`}>
      {loading ? <CollectionSkeleton rows={3} /> : schedules.length === 0 ? <CollectionEmpty title="还没有定时任务" detail="创建计划后，伙伴会按设定在独立会话中执行。" action={<button type="button" disabled={companions.length === 0} onClick={() => setCreating(true)}><IconPlusOutline16 size={14} />创建第一个计划</button>} /> : <div className="dsh-partner-schedule-list">{schedules.map(entry => <article key={entry.id}><span><strong>{entry.title}</strong><p>{entry.prompt}</p><span className="dsh-partner-schedule-meta"><em>@{companionName(companions, entry.companionId)}</em><em>{scheduleLabel(entry)}</em><em>下次 {new Date(entry.nextRunAt).toLocaleString()}</em><em>{entry.destroySessionAfterRun ? '执行后销毁' : '保留会话'}</em></span></span><button type="button" className="dsh-partner-feature-switch" data-on={entry.enabled} aria-pressed={entry.enabled} disabled={busy === entry.id} onClick={() => { void update(entry, { enabled: !entry.enabled }) }}><i /></button><button type="button" disabled={busy === entry.id} onClick={() => { void run(entry) }}><IconPlayOutline16 size={14} />{busy === entry.id ? '执行中…' : '立即执行'}</button><button type="button" className="is-icon" disabled={busy === entry.id} onClick={() => { void remove(entry) }} aria-label={`删除 ${entry.title}`}><IconTrashOutline16 size={14} /></button></article>)}</div>}
    </WorkspaceBlock>
    <WorkspaceBlock title="最近运行" detail="保留最近的状态与结果摘要"><div className="dsh-partner-run-list">{runs.map(run => <article key={run.id} data-status={run.status}><i /><span><strong>{schedules.find(item => item.id === run.sourceId)?.title ?? '已删除计划'} · @{companionName(companions, run.ownerCompanionId)}</strong><p>{run.error || run.outputSummary || '等待结果'}</p><small>{new Date(run.startedAt).toLocaleString()} · {run.status} · {run.destroyAfterRun ? '会话已销毁' : '会话保留'}</small></span></article>)}</div>{!loading && runs.length === 0 && <CollectionEmpty title="还没有执行记录" detail="计划第一次执行后，结果和耗时会显示在这里。" />}</WorkspaceBlock>
  </div>
}

function ScheduleForm({ companions, close, changed }: { companions: CompanionView[]; close(): void; changed(): Promise<void> }): JSX.Element {
  const [kind, setKind] = useState<'interval' | 'daily'>('interval')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    const schedule = kind === 'interval' ? { kind, minutes: Number(data.get('minutes')) } : { kind, hour: Number(data.get('hour')), minute: Number(data.get('minute')) }
    setBusy(true); setError(undefined)
    try {
      await api('/schedules', { method: 'POST', body: JSON.stringify({ companionId: data.get('companionId'), title: data.get('title'), prompt: data.get('prompt'), schedule, enabled: true, destroySessionAfterRun: data.get('retain') !== 'on', overlapPolicy: data.get('overlapPolicy'), timeoutMinutes: Number(data.get('timeoutMinutes')) }) })
      await changed(); close()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <form className="dsh-partner-schedule-form" aria-busy={busy} onSubmit={event => { void submit(event) }}><label><span>计划名称</span><input name="title" required maxLength={160} autoFocus placeholder="例如：每日整理项目变化" /></label><label><span>执行伙伴</span><select name="companionId" required defaultValue={companions[0]?.id ?? ''}><option value="" disabled>选择伙伴</option>{companions.map(companion => <option key={companion.id} value={companion.id}>@{companion.name} · {companion.role}</option>)}</select></label><label className="is-wide"><span>执行内容</span><textarea name="prompt" required maxLength={12000} rows={5} placeholder="明确说明要检查、整理或完成什么，以及希望返回什么结果" /></label><label><span>频率</span><select value={kind} onChange={event => setKind(event.target.value as 'interval' | 'daily')}><option value="interval">每隔一段时间</option><option value="daily">每天固定时间</option></select></label>{kind === 'interval' ? <label><span>间隔分钟</span><input name="minutes" type="number" min={5} max={43200} defaultValue={60} /></label> : <div className="dsh-partner-schedule-time"><label><span>小时</span><input name="hour" type="number" min={0} max={23} defaultValue={9} /></label><label><span>分钟</span><input name="minute" type="number" min={0} max={59} defaultValue={0} /></label></div>}<label><span>重叠策略</span><select name="overlapPolicy" defaultValue="skip"><option value="skip">跳过重叠</option><option value="queue">排队执行</option></select></label><label><span>超时分钟</span><input name="timeoutMinutes" type="number" min={1} max={120} defaultValue={10} /></label><label className="dsh-partner-check is-wide"><input name="retain" type="checkbox" /><i /><span>执行后保留临时会话</span></label>{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy}><IconPlusOutline16 size={14} />{busy ? '创建中…' : '创建计划'}</button></footer></form>
}
function scheduleLabel(entry: ScheduledTaskView): string { return entry.schedule.kind === 'interval' ? `每 ${entry.schedule.minutes} 分钟` : `每天 ${String(entry.schedule.hour).padStart(2, '0')}:${String(entry.schedule.minute).padStart(2, '0')}` }
function companionName(companions: CompanionView[], id: string): string { return companions.find(item => item.id === id)?.name ?? '已删除伙伴' }
