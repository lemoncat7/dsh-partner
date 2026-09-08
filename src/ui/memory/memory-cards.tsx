import {useState} from 'react'
import type {MemoryView, DailyReflectionView} from '../../client-api.js'
import {relativeTime} from '../partner-components.js'
export function DailyReflectionDetail({ entry }: { entry: DailyReflectionView }): JSX.Element {
  return <article className="dsh-partner-diary-detail"><header><time>{entry.date}</time><strong>{entry.turnCount} 轮交流后的理解</strong><small>更新于 {new Date(entry.updatedAt).toLocaleString()}</small></header><p>{entry.summary}</p><ReflectionGroup title="待跟进" items={entry.openTasks} /><ReflectionGroup title="当天事件" items={entry.events} /><ReflectionGroup title="新理解" items={entry.learnings} /><ReflectionGroup title="已完成" items={entry.completedTasks} /></article>
}

function ReflectionGroup({ title, items }: { title: string; items: string[] }): JSX.Element | null {
  if (items.length === 0) return null
  return <section><strong>{title}</strong><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></section>
}

export function MemoryCard({ item, editing, busy, setEditing, save, remove }: { item: MemoryView; editing: MemoryView | undefined; busy: boolean; setEditing(value?: MemoryView): void; save(): void; remove(): void }): JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  return <article data-kind={item.kind}>{editing ? <div className="dsh-partner-memory-editor">
    <input aria-label="记忆主题" value={editing.subject} onChange={event => setEditing({ ...editing, subject: event.target.value })} />
    <textarea aria-label="记忆内容" value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} />
    <footer><button type="button" onClick={() => setEditing(undefined)}>取消</button><button type="button" className="is-primary" disabled={busy || !editing.subject.trim() || !editing.content.trim()} onClick={save}>保存修正</button></footer>
  </div> : <>
    <header><span>{memoryKind(item.kind)}</span><div>{confirmingRemove ? <><button type="button" onClick={() => setConfirmingRemove(false)}>取消</button><button type="button" className="is-danger" disabled={busy} onClick={remove}>确认删除</button></> : <><button type="button" onClick={() => setEditing({ ...item })}>编辑</button><button type="button" onClick={() => setConfirmingRemove(true)}>删除</button></>}</div></header>
    <strong>{item.subject}</strong><p>{item.content}</p>
    <footer><progress max={1} value={item.confidence} aria-label={`置信度 ${Math.round(item.confidence * 100)}%`} /><small>{item.locked ? '手动确认' : `${Math.round(item.confidence * 100)}% 可信`} · {relativeTime(item.updatedAt)}</small></footer>
    {item.evidence.length > 0 && <details className="dsh-partner-memory-evidence"><summary>查看对话依据 <b>{item.evidence.length}</b></summary><div>{[...item.evidence].reverse().map(evidence => <blockquote key={`${evidence.turnId}:${evidence.at}`}><p>{evidence.excerpt}</p><time>{new Date(evidence.at).toLocaleString()}</time></blockquote>)}</div></details>}
  </>}</article>
}

export function memoryKind(value: MemoryView['kind']): string { return ({ profile: '画像', preference: '偏好', task: '任务', event: '事件', relationship: '关系', emotion: '情绪信号' })[value] }

