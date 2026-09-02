import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlayOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type ExecutionRunView, type ScheduledTaskView } from '../client-api.js'

export function SchedulePanel({ companionId }: { companionId: string }): JSX.Element {
  const [schedules, setSchedules] = useState<ScheduledTaskView[]>([])
  const [runs, setRuns] = useState<ExecutionRunView[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try { const value = await api<{ schedules: ScheduledTaskView[]; runs: ExecutionRunView[] }>('/schedules'); setSchedules(value.schedules.filter(item => item.companionId === companionId)); setRuns(value.runs.filter(item => item.ownerCompanionId === companionId && item.kind === 'schedule').slice(-30).reverse()); setError(undefined) }
    catch (reason) { setError(message(reason)) }
  }, [companionId])
  useEffect(() => { void load() }, [load])
  const update = async (entry: ScheduledTaskView, value: Record<string, unknown>): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}`, { method: 'PUT', body: JSON.stringify(value) }); await load() } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) } }
  const run = async (entry: ScheduledTaskView): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}/trigger`, { method: 'POST' }); await load() } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) } }
  const remove = async (entry: ScheduledTaskView): Promise<void> => { setBusy(entry.id); try { await api(`/schedules/${entry.id}`, { method: 'DELETE' }); await load() } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) } }
  return <div className="dsh-partner-feature-page">
    <header className="dsh-partner-feature-hero"><span><small>EPHEMERAL AUTOMATION</small><h2>伙伴定时任务</h2><p>每次执行创建独立临时会话，默认完成即销毁；保留时可用于审计。重启后按 nextRunAt 自动恢复。</p></span><div><button type="button" onClick={() => { void load() }}><IconRefreshOutline16 size={15} />刷新</button><button type="button" onClick={() => setCreating(true)}><IconPlusOutline16 size={15} />新计划</button></div></header>
    {creating && <ScheduleForm companionId={companionId} close={() => setCreating(false)} changed={load} />}
    <section className="dsh-partner-feature-block"><header><span><strong>执行计划</strong><small>{schedules.filter(item => item.enabled).length} 个启用</small></span></header>
      <div className="dsh-partner-schedule-list">{schedules.map(entry => <article key={entry.id}><span><strong>{entry.title}</strong><p>{entry.prompt}</p><small>{scheduleLabel(entry)} · 下次 {new Date(entry.nextRunAt).toLocaleString()} · {entry.destroySessionAfterRun ? '执行后销毁会话' : '保留会话'}</small></span><button type="button" className="dsh-partner-feature-switch" data-on={entry.enabled} aria-pressed={entry.enabled} disabled={busy === entry.id} onClick={() => { void update(entry, { enabled: !entry.enabled }) }}><i /></button><button type="button" disabled={busy === entry.id} onClick={() => { void run(entry) }}><IconPlayOutline16 size={14} />{busy === entry.id ? '执行中…' : '立即执行'}</button><button type="button" className="is-icon" disabled={busy === entry.id} onClick={() => { void remove(entry) }} aria-label={`删除 ${entry.title}`}><IconTrashOutline16 size={14} /></button></article>)}</div>
      {schedules.length === 0 && <p className="dsh-partner-feature-empty">还没有定时任务。</p>}
    </section>
    <section className="dsh-partner-feature-block"><header><span><strong>最近运行</strong><small>保留最近的状态与结果摘要</small></span></header><div className="dsh-partner-run-list">{runs.map(run => <article key={run.id} data-status={run.status}><i /><span><strong>{schedules.find(item => item.id === run.sourceId)?.title ?? '已删除计划'}</strong><p>{run.error || run.outputSummary || '等待结果'}</p><small>{new Date(run.startedAt).toLocaleString()} · {run.status} · {run.destroyAfterRun ? '会话已销毁' : '会话保留'}</small></span></article>)}</div>{runs.length === 0 && <p className="dsh-partner-feature-empty">还没有执行记录。</p>}</section>
    {error && <p className="dsh-partner-error" role="alert">{error}</p>}
  </div>
}

function ScheduleForm({ companionId, close, changed }: { companionId: string; close(): void; changed(): Promise<void> }): JSX.Element {
  const [kind, setKind] = useState<'interval' | 'daily'>('interval')
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    const schedule = kind === 'interval' ? { kind, minutes: Number(data.get('minutes')) } : { kind, hour: Number(data.get('hour')), minute: Number(data.get('minute')) }
    try {
      await api('/schedules', { method: 'POST', body: JSON.stringify({ companionId, title: data.get('title'), prompt: data.get('prompt'), schedule, enabled: true, destroySessionAfterRun: data.get('retain') !== 'on', overlapPolicy: data.get('overlapPolicy'), timeoutMinutes: Number(data.get('timeoutMinutes')) }) })
      await changed(); close()
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-schedule-form" onSubmit={event => { void submit(event) }}><label><span>计划名称</span><input name="title" required maxLength={160} autoFocus /></label><label className="is-wide"><span>执行内容</span><textarea name="prompt" required maxLength={12000} rows={4} placeholder="明确说明要检查、整理或完成什么" /></label><label><span>频率</span><select value={kind} onChange={event => setKind(event.target.value as 'interval' | 'daily')}><option value="interval">每隔一段时间</option><option value="daily">每天固定时间</option></select></label>{kind === 'interval' ? <label><span>间隔分钟</span><input name="minutes" type="number" min={5} max={43200} defaultValue={60} /></label> : <><label><span>小时</span><input name="hour" type="number" min={0} max={23} defaultValue={9} /></label><label><span>分钟</span><input name="minute" type="number" min={0} max={59} defaultValue={0} /></label></>}<label><span>重叠策略</span><select name="overlapPolicy" defaultValue="skip"><option value="skip">跳过重叠</option><option value="queue">排队执行</option></select></label><label><span>超时分钟</span><input name="timeoutMinutes" type="number" min={1} max={120} defaultValue={10} /></label><label className="dsh-partner-check"><input name="retain" type="checkbox" /><i /><span>执行后保留临时会话</span></label><footer><button type="submit"><IconPlusOutline16 size={14} />创建</button><button type="button" onClick={close}>取消</button></footer>{error && <p role="alert">{error}</p>}</form>
}
function scheduleLabel(entry: ScheduledTaskView): string { return entry.schedule.kind === 'interval' ? `每 ${entry.schedule.minutes} 分钟` : `每天 ${String(entry.schedule.hour).padStart(2, '0')}:${String(entry.schedule.minute).padStart(2, '0')}` }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
