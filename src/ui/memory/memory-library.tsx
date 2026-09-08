import {useMemo, useRef, useState} from 'react'
import {IconDataOutline16, IconUserOutline16, IconBrowseOutline16, IconListPenOutline16, IconLinkOutline16} from '@deepseek-ai/dsh-client-ui-primitives'
import type {MemoryView, MemoryGraphView} from '../../client-api.js'
import {CollectionEmpty, WorkspaceDialog, WorkspaceNotice} from '../workspace-components.js'
import {relativeTime} from '../partner-components.js'
import {MemoryDetail} from './memory-detail.js'
import {DailyReflectionDetail, memoryKind} from './memory-cards.js'
import {MemoryGraph} from './memory-graph.js'
import {HistoryView} from './history-view.js'
import {ExperienceView} from './experience-view.js'
import {useMemoryResource} from './use-memory-resource.js'
import {MEMORY_STATUS, type MemoryCollection, type MemoryLayers, type MemoryMode} from './types.js'

export function MemoryLibrary({companionId, scopeId, collection, layers, changed}: {companionId: string; scopeId: string; collection: MemoryCollection; layers: MemoryLayers | undefined; changed(): Promise<void>}): JSX.Element {
  const [mode, setMode] = useState<MemoryMode>('profile')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<MemoryView['status'] | 'all'>('active')
  const [kind, setKind] = useState<MemoryView['kind'] | 'all'>('all')
  const [limit, setLimit] = useState(20)
  const [inspecting, setInspecting] = useState<MemoryView>()
  const [date, setDate] = useState<string>()
  const more = useRef<HTMLDetailsElement>(null)
  const base = `/companions/${encodeURIComponent(companionId)}`
  const graph = useMemoryResource<MemoryGraphView>(mode === 'graph' ? `${base}/memory/graph` : undefined)
  const normalized = query.trim().toLocaleLowerCase()
  const profile = collection.profiles.find(item => item.scopeId === scopeId)
  const filtered = useMemo(() => collection.memories.filter(item => item.scopeId === scopeId && (status === 'all' || item.status === status)
    && (kind === 'all' || item.kind === kind) && (!normalized || `${item.subject} ${item.content}`.toLocaleLowerCase().includes(normalized))), [collection.memories, scopeId, status, kind, normalized])
  const reflections = collection.reflections.filter(item => item.scopeId === scopeId && (!normalized || `${item.date} ${item.summary}`.toLocaleLowerCase().includes(normalized)))
  const selectedDay = reflections.find(item => item.date === date)
  const selectMode = (value: MemoryMode): void => {setMode(value); setQuery(''); setLimit(20); if (more.current) more.current.open = false}
  const row = (item: MemoryView) => <button type="button" className="dsh-partner-memory-row" key={item.id} onClick={() => setInspecting(item)}>
    <span className="dsh-partner-memory-row-copy"><strong>{item.subject}</strong><p>{item.content}</p><small>{memoryKind(item.kind)} · {item.locked ? '用户确认' : `${Math.round(item.confidence * 100)}% 可信`} · {relativeTime(item.updatedAt)}</small></span>
    <span className="dsh-partner-memory-badge" data-status={item.status}>{MEMORY_STATUS[item.status]}</span>
  </button>
  return <section className="dsh-partner-memory-library-v2">
    <nav className="dsh-partner-memory-nav" aria-label="记忆内容">
      <button type="button" aria-pressed={mode === 'profile'} onClick={() => selectMode('profile')}><IconUserOutline16 size={16} />画像</button>
      <button type="button" aria-pressed={mode === 'memory' || mode === 'scenes'} onClick={() => selectMode('memory')}><IconDataOutline16 size={16} />记忆</button>
      <button type="button" aria-pressed={mode === 'reflection' || mode === 'history'} onClick={() => selectMode('reflection')}><IconBrowseOutline16 size={16} />回顾</button>
      <details className="dsh-partner-memory-more" ref={more} onKeyDown={event => {if (event.key === 'Escape' && more.current) {more.current.open = false; more.current.querySelector('summary')?.focus()}}}>
        <summary aria-label="更多记忆内容">{mode === 'experiences' ? '经验审核' : mode === 'graph' ? '关系图谱' : '更多'} <span aria-hidden="true">⋯</span></summary>
        <div><button type="button" onClick={() => selectMode('experiences')}><IconListPenOutline16 size={16} />经验审核 <small>{layers?.experiences.filter(item => item.status === 'draft').length ?? 0}</small></button><button type="button" onClick={() => selectMode('graph')}><IconLinkOutline16 size={16} />关系图谱</button></div>
      </details>
    </nav>
    {(mode === 'memory' || mode === 'scenes') && <div className="dsh-partner-memory-segment" aria-label="记忆视图"><button type="button" aria-pressed={mode === 'memory'} onClick={() => selectMode('memory')}>记忆条目</button><button type="button" aria-pressed={mode === 'scenes'} onClick={() => selectMode('scenes')}>场景摘要</button></div>}
    {(mode === 'reflection' || mode === 'history') && <div className="dsh-partner-memory-segment" aria-label="回顾视图"><button type="button" aria-pressed={mode === 'reflection'} onClick={() => selectMode('reflection')}>每日回顾</button><button type="button" aria-pressed={mode === 'history'} onClick={() => selectMode('history')}>对话历史</button></div>}
    {mode !== 'profile' && mode !== 'experiences' && <div className="dsh-partner-memory-toolbar"><label className="dsh-partner-memory-search"><span className="sr-only">搜索当前内容</span><input type="search" placeholder={mode === 'history' ? '搜索已加载的历史' : '搜索当前内容'} value={query} onChange={event => {setQuery(event.target.value); setLimit(20)}} /></label>{mode === 'memory' && <>
      <label><span className="sr-only">记忆状态</span><select aria-label="记忆状态" value={status} onChange={event => {setStatus(event.target.value as typeof status); setLimit(20)}}><option value="all">全部状态</option>{Object.entries(MEMORY_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className="sr-only">记忆类型</span><select aria-label="记忆类型" value={kind} onChange={event => {setKind(event.target.value as typeof kind); setLimit(20)}}><option value="all">全部类型</option>{(['profile', 'preference', 'task', 'event', 'relationship', 'emotion'] as const).map(value => <option key={value} value={value}>{memoryKind(value)}</option>)}</select></label>
    </>}</div>}
    {mode === 'profile' && <div className="dsh-partner-memory-profile"><header><span><small>基于有效记忆，而不是猜测</small><h3>伙伴对你的理解</h3></span><small>{profile?.updatedAt ? `更新于 ${relativeTime(profile.updatedAt)}` : '等待可靠依据'}</small></header>
      <section><h4>明确事实</h4><div className="dsh-partner-memory-rows">{profile?.entries.map(row)}</div>{!profile?.entries.length && <CollectionEmpty title="还没有足够的身份与背景信息" detail="只收录你明确表达的事实，不推测职业、性格或隐私。" />}</section>
      <section><h4>稳定协作偏好</h4><div className="dsh-partner-memory-rows">{profile?.preferences?.map(row)}</div>{!profile?.preferences?.length && <CollectionEmpty title="还在积累稳定偏好" detail="反复确认或手动锁定的可靠偏好会出现在这里。" />}</section>
      {profile && <p className="dsh-partner-memory-hint">{profile.evidenceCount} 处对话依据 · {profile.lockedCount} 项用户确认 <span title={profile.version}>· 画像版本 {profile.version.slice(0, 8)}</span></p>}
    </div>}
    {mode === 'memory' && <><p className="dsh-partner-memory-hint">当前联系人最近 100 条中，匹配 {filtered.length} 条。点击条目查看依据或修正。</p><div className="dsh-partner-memory-rows">{filtered.slice(0, limit).map(row)}</div>{!filtered.length && <CollectionEmpty title="没有匹配的记忆" detail="可以切换状态查看已完成、过期或被替代的内容。" />}{filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 20)}>再显示 20 条</button>}</>}
    {mode === 'scenes' && <><p className="dsh-partner-memory-hint">摘要引用当前有效记忆，原记忆修正后同步变化。每日终审时整理。</p>{layers?.scenes.filter(scene => !normalized || `${scene.title} ${scene.summary}`.toLocaleLowerCase().includes(normalized)).map(scene => <details className="dsh-partner-memory-record" key={scene.id}><summary><strong>{scene.title}</strong><small>{scene.memoryIds.length} 条依据</small></summary><div><p>{scene.summary}</p><small>{relativeTime(scene.updatedAt)}</small></div></details>)}{!layers?.scenes.some(scene => !normalized || (scene.title + ' ' + scene.summary).toLocaleLowerCase().includes(normalized)) && <CollectionEmpty title={normalized ? "没有匹配的场景摘要" : "还没有场景摘要"} detail="开启每日终审后，会逐步将相关的有效记忆组织在一起。" />}</>}
    {mode === 'reflection' && <><div className="dsh-partner-memory-rows">{reflections.map(day => <button className="dsh-partner-memory-row" type="button" key={`${day.scopeId}:${day.date}`} onClick={() => setDate(day.date)}><span><strong>{day.date}</strong><p>{day.summary}</p><small>{day.turnCount} 轮交流 · {day.completedTasks.length} 项完成</small></span><small>查看</small></button>)}</div>{!reflections.length && <CollectionEmpty title="还没有匹配的回顾" detail="学习开启后，在后台完成提炼时更新。" />}</>}
    {mode === 'history' && <HistoryView key={scopeId} base={base} scopeId={scopeId} query={normalized} />}
    {mode === 'experiences' && <ExperienceView items={layers?.experiences ?? []} base={base} scopeId={scopeId} changed={changed} />}
    {mode === 'graph' && <>{graph.error && <WorkspaceNotice>{graph.error} <button type="button" onClick={() => {void graph.reload()}}>重试</button></WorkspaceNotice>}{graph.data ? <MemoryGraph graph={{memories: graph.data.memories.filter(item => item.scopeId === scopeId), relations: graph.data.relations.filter(item => item.scopeId === scopeId)}} profiles={collection.profiles.filter(item => item.scopeId === scopeId)} query={normalized} inspect={setInspecting} /> : !graph.error && <CollectionEmpty title="正在读取关系图谱" />}</>}
    {inspecting && <MemoryDetail key={inspecting.id} companionId={companionId} item={inspecting} close={() => setInspecting(undefined)} changed={changed} />}
    {selectedDay && <WorkspaceDialog title={`${selectedDay.date} 每日回顾`} detail="过程记录与当日总结，不直接作为长期事实。" close={() => setDate(undefined)}><DailyReflectionDetail entry={selectedDay} /></WorkspaceDialog>}
  </section>
}
