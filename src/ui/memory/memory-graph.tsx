import {useState} from 'react'
import type {MemoryView, MemoryRelationView, MemoryGraphView, UserProfileSnapshotView} from '../../client-api.js'
import {ContentState as State} from '../partner-components.js'
import {memoryKind} from './memory-cards.js'
type RelationFilter = MemoryRelationView['kind'] | 'all'
const RELATION_FILTERS: RelationFilter[] = ['all', 'conflicts_with', 'depends_on', 'supports', 'follows', 'about']

export function MemoryGraph({ graph, profiles, query, inspect }: { graph: MemoryGraphView; profiles: UserProfileSnapshotView[]; query: string; inspect(item: MemoryView): void }): JSX.Element {
  const byId = new Map(graph.memories.map(item => [item.id, item]))
  const scopeIds = [...new Set(graph.relations.map(item => item.scopeId))]
  const [requestedScopeId, setRequestedScopeId] = useState<string>()
  const scopeId = scopeIds.includes(requestedScopeId ?? '') ? requestedScopeId! : scopeIds[0]
  const [filter, setFilter] = useState<RelationFilter>('all')
  const scoped = graph.relations.filter(item => item.scopeId === scopeId)
  const visible = scoped.filter(item => {
    if (filter !== 'all' && item.kind !== filter) return false
    const source = byId.get(item.sourceMemoryId); const target = byId.get(item.targetMemoryId)
    return !query || `${source?.subject ?? ''} ${source?.content ?? ''} ${target?.subject ?? ''} ${target?.content ?? ''} ${item.label}`.toLocaleLowerCase().includes(query)
  }).sort((left, right) => Number(right.kind === 'conflicts_with') - Number(left.kind === 'conflicts_with') || right.confidence - left.confidence)
  const [selectedRelationId, setSelectedRelationId] = useState<string>()
  const selected = visible.find(item => item.id === selectedRelationId) ?? visible[0]
  const source = selected ? byId.get(selected.sourceMemoryId) : undefined
  const target = selected ? byId.get(selected.targetMemoryId) : undefined
  const label = profiles.find(item => item.scopeId === scopeId)?.label ?? (scopeId ? `联系人 ${scopeId.slice(-6)}` : '当前联系人')
  const conflictCount = scoped.filter(item => item.kind === 'conflicts_with').length
  if (graph.relations.length === 0) return <State title="还没有可靠关系" detail="每日终审只会保存有明确证据的记忆联系，不会为了填满图谱而猜测。" />
  return <div className="dsh-partner-graph-audit">
    <header className="dsh-partner-graph-toolbar"><span><small>关系审计</small><strong>{label} 的理解关系</strong><p>{scoped.length} 条可靠联系{conflictCount > 0 ? `，其中 ${conflictCount} 条需要确认` : '，暂无待确认冲突'}</p></span>{scopeIds.length > 1 && <label><span>联系人</span><select value={scopeId} onChange={event => { setRequestedScopeId(event.target.value); setSelectedRelationId(undefined) }}>{scopeIds.map(value => <option value={value} key={value}>{profiles.find(item => item.scopeId === value)?.label ?? `联系人 ${value.slice(-6)}`}</option>)}</select></label>}</header>
    <nav className="dsh-partner-graph-filters" aria-label="关系类型">{RELATION_FILTERS.map(value => { const count = value === 'all' ? scoped.length : scoped.filter(item => item.kind === value).length; return <button type="button" key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelectedRelationId(undefined) }}>{value === 'all' ? '全部' : relationLabel(value)} <b>{count}</b></button> })}</nav>
    <div className="dsh-partner-graph-browser"><div className="dsh-partner-graph-index" role="list">{visible.length === 0 ? <State title="没有匹配的关系" detail="调整关系类型或搜索关键词后再试。" compact /> : visible.map(item => { const from = byId.get(item.sourceMemoryId); const to = byId.get(item.targetMemoryId); return <button type="button" role="listitem" key={item.id} data-kind={item.kind} className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedRelationId(item.id)}><span>{relationLabel(item.kind)}</span><strong>{from?.subject ?? '已删除记忆'} <i aria-hidden="true">→</i> {to?.subject ?? '已删除记忆'}</strong><p>{item.label}</p><small>{Math.round(item.confidence * 100)}% 可信</small></button> })}</div>
      <div className="dsh-partner-graph-stage">{selected && source && target ? <article data-kind={selected.kind}><header><span>{relationLabel(selected.kind)}</span><strong>{source.subject} <i aria-hidden="true">→</i> {target.subject}</strong><p>{selected.label}</p><small>{relationGuidance(selected.kind)}</small></header><div className="dsh-partner-graph-pair"><GraphMemory item={source} side="起点" inspect={inspect} /><div aria-hidden="true"><i /><span>{relationLabel(selected.kind)}</span><i /></div><GraphMemory item={target} side="关联项" inspect={inspect} /></div><footer><small>最近终审于 {new Date(selected.updatedAt).toLocaleString()}</small><strong>关系置信度 {Math.round(selected.confidence * 100)}%</strong></footer></article> : <State title="选择一条关系" detail="关系两端的记忆与使用方式会显示在这里。" compact />}</div>
    </div>
  </div>
}

function GraphMemory({ item, side, inspect }: { item: MemoryView; side: string; inspect(item: MemoryView): void }): JSX.Element {
  return <section><header><small>{side} · {memoryKind(item.kind)}</small><strong>{item.subject}</strong></header><p>{item.content}</p><button type="button" onClick={() => inspect(item)}>查看并修正</button></section>
}

function relationLabel(kind: MemoryRelationView['kind']): string { return ({ supports: '支持', depends_on: '依赖', about: '关于', conflicts_with: '冲突', follows: '后续' })[kind] }
function relationGuidance(kind: MemoryRelationView['kind']): string {
  return ({
    supports: '回答涉及目标记忆时，可把起点作为明确支持依据，但不能据此补写新事实。',
    depends_on: '处理起点事项时，应同时检查关联项是否成立或已经完成。',
    about: '两条记忆属于同一上下文，召回其中一条时可以补充另一条帮助理解。',
    conflicts_with: '两条理解暂时不能同时作为事实；伙伴应在相关话题出现时指出差异并请求确认。',
    follows: '它们存在明确先后关系，后续判断需要保留这个顺序。',
  })[kind]
}


