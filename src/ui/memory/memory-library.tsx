import {useMemo, useRef, useState} from 'react'
import {IconDataOutline16, IconBrowseOutline16, IconListPenOutline16, IconLinkOutline16} from '@deepseek-ai/dsh-client-ui-primitives'
import type {MemoryView, MemoryGraphView} from '../../client-api.js'
import {CollectionEmpty, WorkspaceDialog, WorkspaceNotice} from '../workspace-components.js'
import {relativeTime} from '../partner-components.js'
import {MemoryDetail} from './memory-detail.js'
import {DailyReflectionDetail, memoryKind} from './memory-cards.js'
import {MemoryGraph} from './memory-graph.js'
import {HistoryView} from './history-view.js'
import {PersonaView} from './persona-view.js'
import {ExperienceView} from './experience-view.js'
import {useMemoryResource} from './use-memory-resource.js'
import {MEMORY_STATUS, type MemoryCollection, type MemoryLayers, type MemoryMode} from './types.js'

export function MemoryLibrary({companionId, scopeId, collection, layers, enabled, changed}: {companionId: string; scopeId: string; collection: MemoryCollection; layers: MemoryLayers | undefined; enabled: boolean; changed(): Promise<void>}): JSX.Element {
  const [mode, setMode] = useState<MemoryMode>('memory')
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
  const row = (item: MemoryView) => <button type="button" className="dsh-partner-memory-row" key={item.id} aria-label={`${item.subject}：${item.content}`} onClick={() => setInspecting(item)}>
    <span className="dsh-partner-memory-list-kind">{memoryKind(item.kind)}</span>
    <span className="dsh-partner-memory-row-copy"><p>{item.content}</p></span>
    <small className="dsh-partner-memory-list-state">{MEMORY_STATUS[item.status]}</small>
    <time dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt)}</time>
  </button>
  return <section className="dsh-partner-memory-library-v2">
    <nav className="dsh-partner-memory-nav" aria-label="记忆内容">
      <button type="button" aria-pressed={mode === 'memory' || mode === 'scenes'} onClick={() => selectMode('memory')}><IconDataOutline16 size={16} />记忆</button>
      <button type="button" aria-pressed={mode === 'reflection' || mode === 'history'} onClick={() => selectMode('reflection')}><IconBrowseOutline16 size={16} />回顾</button>
      <details className="dsh-partner-memory-more" ref={more} onKeyDown={event => {if (event.key === 'Escape' && more.current) {more.current.open = false; more.current.querySelector('summary')?.focus()}}}>
        <summary aria-label="更多记忆内容">{mode === 'experiences' ? '经验审核' : mode === 'graph' ? '关系图谱' : '更多'} <span aria-hidden="true">⋯</span></summary>
        <div><button type="button" onClick={() => selectMode('scenes')}><IconDataOutline16 size={16} />场景摘要</button><button type="button" onClick={() => selectMode('experiences')}><IconListPenOutline16 size={16} />经验审核 <small>{layers?.experiences.filter(item => item.status === 'draft').length ?? 0}</small></button><button type="button" onClick={() => selectMode('graph')}><IconLinkOutline16 size={16} />关系图谱</button></div>
      </details>
    </nav>
    {mode === 'scenes' && <h3>场景摘要</h3>}
    {(mode === 'reflection' || mode === 'history') && <div className="dsh-partner-memory-segment" aria-label="回顾视图"><button type="button" aria-pressed={mode === 'reflection'} onClick={() => selectMode('reflection')}>每日回顾</button><button type="button" aria-pressed={mode === 'history'} onClick={() => selectMode('history')}>对话历史</button></div>}
    {mode === 'memory' && <PersonaView view={profile?.persona} base={base} scopeId={scopeId} enabled={enabled} changed={changed} />}
    {mode !== 'experiences' && <div className="dsh-partner-memory-toolbar"><label className="dsh-partner-memory-search"><span className="sr-only">搜索当前内容</span><input type="search" placeholder={mode === 'history' ? '搜索已加载的历史' : '搜索记忆内容'} value={query} onChange={event => {setQuery(event.target.value); setLimit(20)}} /></label>{mode === 'memory' && <>
      <label><span className="sr-only">记忆状态</span><select aria-label="记忆状态" value={status} onChange={event => {setStatus(event.target.value as typeof status); setLimit(20)}}><option value="all">全部状态</option>{Object.entries(MEMORY_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className="sr-only">记忆类型</span><select aria-label="记忆类型" value={kind} onChange={event => {setKind(event.target.value as typeof kind); setLimit(20)}}><option value="all">全部类型</option>{(['profile', 'preference', 'task', 'event', 'relationship', 'emotion'] as const).map(value => <option key={value} value={value}>{memoryKind(value)}</option>)}</select></label>
    </>}</div>}
    {mode === 'memory' && <><p className="dsh-partner-memory-hint">当前记忆范围最近 100 条中，匹配 {filtered.length} 条。点击查看依据、可信度或修改内容。</p><div className="dsh-partner-memory-rows dsh-partner-memory-list">{filtered.slice(0, limit).map(row)}</div>{!filtered.length && <CollectionEmpty title="没有匹配的记忆" detail="可以切换类型或状态查看其他记忆。" />}{filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 20)}>再显示 20 条</button>}</>}
    {mode === 'scenes' && <><p className="dsh-partner-memory-hint">摘要引用当前有效记忆，原记忆修正后同步变化。每日终审时整理。</p>{layers?.scenes.filter(scene => !normalized || `${scene.title} ${scene.summary}`.toLocaleLowerCase().includes(normalized)).map(scene => <details className="dsh-partner-memory-record" key={scene.id}><summary><strong>{scene.title}</strong><small>{scene.memoryIds.length} 条依据</small></summary><div><p>{scene.summary}</p><small>{relativeTime(scene.updatedAt)}</small></div></details>)}{!layers?.scenes.some(scene => !normalized || (scene.title + ' ' + scene.summary).toLocaleLowerCase().includes(normalized)) && <CollectionEmpty title={normalized ? "没有匹配的场景摘要" : "还没有场景摘要"} detail="开启每日终审后，会逐步将相关的有效记忆组织在一起。" />}</>}
    {mode === 'reflection' && <><div className="dsh-partner-memory-rows">{reflections.map(day => <button className="dsh-partner-memory-row" type="button" key={`${day.scopeId}:${day.date}`} onClick={() => setDate(day.date)}><span><strong>{day.date}</strong><p>{day.summary}</p><small>{day.turnCount} 轮交流 · {day.completedTasks.length} 项完成</small></span><small>查看</small></button>)}</div>{!reflections.length && <CollectionEmpty title="还没有匹配的回顾" detail="学习开启后，在后台完成提炼时更新。" />}</>}
    {mode === 'history' && <HistoryView key={scopeId} base={base} scopeId={scopeId} query={normalized} />}
    {mode === 'experiences' && <ExperienceView items={layers?.experiences ?? []} base={base} scopeId={scopeId} changed={changed} />}
    {mode === 'graph' && <>{graph.error && <WorkspaceNotice>{graph.error} <button type="button" onClick={() => {void graph.reload()}}>重试</button></WorkspaceNotice>}{graph.data ? <MemoryGraph graph={{memories: graph.data.memories.filter(item => item.scopeId === scopeId), relations: graph.data.relations.filter(item => item.scopeId === scopeId)}} profiles={collection.profiles.filter(item => item.scopeId === scopeId)} query={normalized} inspect={setInspecting} /> : !graph.error && <CollectionEmpty title="正在读取关系图谱" />}</>}
    {inspecting && <MemoryDetail key={inspecting.id} companionId={companionId} item={inspecting} close={() => setInspecting(undefined)} changed={changed} />}
    {selectedDay && <WorkspaceDialog title={`${selectedDay.date} 每日回顾`} detail="过程记录与当日总结，不直接作为长期事实。" close={() => setDate(undefined)}><DailyReflectionDetail entry={selectedDay} /></WorkspaceDialog>}
  </section>
}
