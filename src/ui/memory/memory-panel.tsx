import {useRef, useState} from 'react'
import {IconRefreshOutline16} from '@deepseek-ai/dsh-client-ui-primitives'
import {api, type CompanionView, type PartnerSnapshot} from '../../client-api.js'
import {WorkspaceHero, WorkspaceNotice, CollectionEmpty, errorMessage} from '../workspace-components.js'
import {MemoryLibrary} from './memory-library.js'
import {AutomationSettings} from './automation-settings.js'
import {useMemoryResource} from './use-memory-resource.js'
import type {MemoryCollection, MemoryLayers} from './types.js'
import {MemoryJobFeedback} from './job-feedback.js'

export function MemoryPanel({companion, snapshot, openSession, startSession, renewSession, onChanged}: {
  companion: CompanionView; snapshot: PartnerSnapshot; openSession(routeId: string, sessionId: string): Promise<void>;
  startSession(companionId: string): Promise<void>; renewSession(routeId: string): Promise<void>; onChanged(): Promise<void>
}): JSX.Element {
  const sessions = snapshot.sessions.filter(item => item.companionId === companion.id).sort((a, b) => Number(b.kind === 'local') - Number(a.kind === 'local') || b.lastMessageAt - a.lastMessageAt)
  const [requestedScope, setScope] = useState('')
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const base = `/companions/${encodeURIComponent(companion.id)}`
  const initialScope = sessions[0] ? `${sessions[0].channelId}:${sessions[0].userId}` : ''
  const requested = requestedScope || initialScope
  const collection = useMemoryResource<MemoryCollection>(`${base}/memory${requested ? `?${new URLSearchParams({scopeId: requested})}` : ''}`, 15_000)
  const scopeId = requested || collection.data?.profiles[0]?.scopeId || ''
  const layers = useMemoryResource<MemoryLayers>(scopeId ? `${base}/memory/layers?${new URLSearchParams({scopeId})}` : undefined, 15_000)
  const reload = async (): Promise<void> => {await Promise.all([collection.reload(), layers.reload()])}
  const run = async (action: () => Promise<void>, success: string): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setNotice(undefined)
    try {await action(); setNotice(success); await reload()}
    catch (reason) {setError(errorMessage(reason))}
    finally {lock.current = false; setBusy(false)}
  }
  const retries = layers.data?.retryCount ?? layers.data?.jobs.filter(job => job.status === 'retrying').length ?? 0
  const [showAllJobs,setShowAllJobs] = useState(false)
  const scopes = collection.data?.profiles ?? []
  return <div className="dsh-partner-memory-page">
    <WorkspaceHero eyebrow="MEMORY & CONTEXT" title="记忆库" detail="知道记住了什么、依据是什么，也能纠正已经过时的理解。" actions={<button type="button" onClick={() => setSettings(true)}>记忆设置</button>} />
    <div className="dsh-partner-memory-context"><label><span>当前联系人</span><select aria-label="当前联系人" value={scopeId} onChange={event => {setScope(event.target.value); setError(undefined); setNotice(undefined)}}>
      {!scopes.length && <option value={scopeId}>{scopeId ? '本地对话' : '暂无联系人'}</option>}
      {scopes.map(profile => <option value={profile.scopeId} key={profile.scopeId}>{sessions.some(session => session.kind === 'local' && `${session.channelId}:${session.userId}` === profile.scopeId) ? '本地对话' : profile.label}</option>)}
    </select></label><span className="dsh-partner-memory-badge">{companion.automation.memory.enabled ? '学习已开启' : '学习已暂停'}</span><button type="button" aria-label="刷新记忆" disabled={collection.loading || layers.loading} onClick={() => {void reload()}}><IconRefreshOutline16 size={16} /></button></div>
    {(error || collection.error || layers.error) && <WorkspaceNotice>{error || collection.error || layers.error}</WorkspaceNotice>}{notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    {!!layers.data?.jobs.length && <details className="dsh-partner-memory-jobs"><summary>{layers.data.jobCount ?? layers.data.jobs.length} 项尚未整理 · {retries} 项失败重试<small>原始对话已保存，不影响继续聊天</small></summary><div>{layers.data.jobs.slice(0, showAllJobs ? 100 : 10).map(job => <div key={job.id}><span>{job.at && <small>{new Date(job.at).toLocaleString()}</small>}{job.status === 'processing' ? '正在整理' : job.status === 'retrying' ? `已失败 ${job.attempts} 次 · 下次 ${new Date(job.nextAt).toLocaleTimeString()}` : '等待执行，无需重复提交'}<MemoryJobFeedback status={job.status} {...(job.error ? {error:job.error} : {})} />{job.attempts >= 3 && job.status === 'retrying' && <small>退避期间允许后续任务继续整理</small>}</span>{job.status === 'retrying' && <button type="button" disabled={busy} onClick={() => {void run(async () => {await api(`${base}/memory/jobs/${encodeURIComponent(job.id)}?${new URLSearchParams({scopeId})}`, {method: 'POST'})}, '已安排重试，当前执行结束后处理')}}>重新排队</button>}</div>)}{layers.data.jobs.length>10 && <button type="button" onClick={()=>setShowAllJobs(!showAllJobs)}>{showAllJobs?'收起':'显示更多任务'}</button>}{(layers.data.jobCount ?? 0)>100 && <p>仅展示最早100项，完成后自动补充后续任务。</p>}</div></details>}
    {!collection.data ? <CollectionEmpty title={collection.error ? '记忆读取失败' : '正在读取记忆'} action={collection.error ? <button type="button" onClick={() => {void reload()}}>重试</button> : undefined} /> : <MemoryLibrary key={scopeId} companionId={companion.id} scopeId={scopeId} collection={collection.data} layers={layers.data} changed={reload} />}
    <details className="dsh-partner-memory-record is-sessions"><summary>伙伴会话 <small>{sessions.length}</small></summary><div>{sessions.map(session => <div className="dsh-partner-memory-session" key={session.id}><span><strong>{session.kind === 'local' ? '本地对话' : `渠道联系人 · ${session.userId.slice(-6)}`}</strong><small>{session.archived ? '已归档' : '可继续对话'}</small></span><button type="button" disabled={busy} onClick={() => {void run(() => session.archived ? renewSession(session.id) : openSession(session.id, session.sessionId), session.archived ? '新会话已创建' : '会话已打开')}}>{session.archived ? '新建会话' : '打开会话'}</button></div>)}{!sessions.length && <button type="button" disabled={busy} onClick={() => {void run(() => startSession(companion.id), '会话已创建')}}>开始对话</button>}</div></details>
    {settings && <AutomationSettings companion={companion} kind="memory" close={() => setSettings(false)} onChanged={async () => {await onChanged(); await reload()}} />}
  </div>
}
