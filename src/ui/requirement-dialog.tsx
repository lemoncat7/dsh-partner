import { useState, type FormEvent } from 'react'
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type BoardTaskView, type PartnerDirectoryEntryView, type RequirementView } from '../client-api.js'
import { WorkspaceNotice, errorMessage } from './workspace-components.js'

export function requirementStatus(item: RequirementView): string {
  if (item.lastError) return item.status === 'done' ? '已归档 · 通知待重试' : '收尾待重试'
  return { planning: '规划中', active: '推进中', review: '汇总中', done: '已归档' }[item.status]
}

export function RequirementForm({ directory, close, created }: { directory: PartnerDirectoryEntryView[]; close(): void; created(item: RequirementView): Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(undefined)
    try { const item = await api<RequirementView>('/requirements', { method: 'POST', body: JSON.stringify({ title: data.get('title'), description: data.get('description'), ownerCompanionId: data.get('owner') || undefined }) }); await created(item) }
    catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <form className="dsh-partner-task-form" aria-busy={busy} onSubmit={event => { void submit(event) }}>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    <label className="is-wide"><span>需求名称</span><input name="title" autoFocus required maxLength={200} placeholder="这次希望完成什么" /></label>
    <label className="is-wide"><span>交付目标</span><textarea name="description" rows={5} maxLength={8000} placeholder="背景、预期成果与整体完成标准" /></label>
    <label className="is-wide"><span>收尾负责人</span><select name="owner" defaultValue=""><option value="">人工汇总</option>{directory.map(c => <option value={c.id} key={c.id}>@{c.name}</option>)}</select><small>子任务全部通过验收后，由该伙伴总结并通过需求来源渠道通知。</small></label>
    <footer><button type="button" onClick={close} disabled={busy}>取消</button><button type="submit" className="is-primary" disabled={busy}>{busy ? '创建中…' : '创建并安排任务'}</button></footer>
  </form>
}

export function RequirementDetail({ item, tasks, directory, changed, close }: { item: RequirementView; tasks: BoardTaskView[]; directory: PartnerDirectoryEntryView[]; changed(): Promise<void>; close(): void }): JSX.Element {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [confirming, setConfirming] = useState(false), [summary, setSummary] = useState('')
  const done = tasks.filter(t => t.status === 'done').length, ready = tasks.length > 0 && done === tasks.length && item.status !== 'planning'
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(undefined)
    try { await api(`/requirements/${item.id}${action === 'remove' ? '' : `/${action}`}`, { method: action === 'remove' ? 'DELETE' : 'POST', body: JSON.stringify({ expectedRevision: item.revision, ...body }) }); if (action === 'remove') close(); await changed() }
    catch (reason) { await changed(); setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <div className="dsh-partner-task-detail dsh-partner-requirement-detail" aria-busy={busy}>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    <section className="dsh-partner-task-description"><strong>交付目标</strong><p>{item.description || '未补充交付目标'}</p></section>
    <div className="dsh-partner-requirement-facts"><span>收尾负责人<b>{directory.find(c => c.id === item.ownerCompanionId)?.name ?? '人工汇总'}</b></span><span>子任务验收<b>{item.status === 'done' ? `${item.results?.length ?? done} 项已归档` : `${done} / ${tasks.length}`}</b></span><span>通知方式<b>{item.creatorSessionId ? '需求来源会话 / 渠道' : '看板内查看结果'}</b></span></div>
    {item.lastError && <WorkspaceNotice>{item.lastError} · 系统会自动重试，也可立即重试。<button type="button" disabled={busy} onClick={() => { void act('retry') }}>立即重试</button></WorkspaceNotice>}
    {item.summary && <section className="dsh-partner-task-result"><strong>最终结论</strong><p>{item.summary}</p></section>}
    {!!item.results?.length && <details className="dsh-partner-requirement-disclosure"><summary>交付记录 · {item.results.length} 项</summary>{item.results.map(result => <section className="dsh-partner-task-result" key={result.id}><strong>{result.title}</strong><p>{result.resultSummary || result.resultAbstract || '未提供结果正文'}</p></section>)}</details>}
    {item.status !== 'done' && <>
      <label className="dsh-partner-requirement-owner"><span>调整收尾负责人</span><select aria-label="收尾负责人" value={item.ownerCompanionId ?? ''} disabled={busy} onChange={event => { void act('owner', { ownerCompanionId: event.target.value }) }}><option value="">人工汇总</option>{item.ownerCompanionId && !directory.some(c => c.id === item.ownerCompanionId) && <option value={item.ownerCompanionId}>原负责人已删除</option>}{directory.map(c => <option value={c.id} key={c.id}>@{c.name}</option>)}</select></label>
      <WorkspaceNotice kind="warning">{item.status === 'planning' ? '全部子任务安排好后，提交本次规划；删除子任务会重新打开规划，需确认新的交付范围。' : '子任务的执行和验收只在内部流转，全部完成后才汇总需求结果。'}</WorkspaceNotice>
      {ready && <details className="dsh-partner-requirement-disclosure"><summary>人工完成收尾</summary><label><span>最终结论</span><textarea rows={5} maxLength={12000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="确认实际交付内容、结论及限制" /></label><button type="button" disabled={busy || !summary.trim()} onClick={() => { void act('finish', { summary }) }}>保存总结并归档</button></details>}
    </>}
    <details className="dsh-partner-requirement-disclosure"><summary>管理需求</summary><p>删除需求会同时移除子任务，并取消关联执行。不能撤销，不会删除已生成的交付文件。</p>{confirming ? <div className="dsh-partner-requirement-actions"><button type="button" disabled={busy} onClick={() => setConfirming(false)}>保留需求</button><button type="button" className="is-danger" disabled={busy} onClick={() => { void act('remove') }}>确认删除需求和 {tasks.length} 个任务</button></div> : <button type="button" className="is-danger" onClick={() => setConfirming(true)}><IconTrashOutline16 size={14} />删除需求</button>}</details>
    <footer><button type="button" onClick={close} disabled={busy}>关闭</button>{item.status !== 'done' && <button type="button" className="is-primary" disabled={busy || (item.status === 'planning' && !tasks.length)} onClick={() => { void act(item.status === 'planning' ? 'submit' : 'reopen') }}>{busy ? '处理中…' : item.status === 'planning' ? '提交规划' : '调整任务范围'}</button>}</footer>
  </div>
}
