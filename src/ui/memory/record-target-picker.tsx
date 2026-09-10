import { useEffect, useId, useState } from 'react'
import { api, type ConcernRecordTargetView } from '../../client-api.js'

export function RecordTargetPicker({ companionId, value, onChange }: {
  companionId: string; value: ConcernRecordTargetView | undefined; onChange(value?: ConcernRecordTargetView): void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ConcernRecordTargetView[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const hint = useId()
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      api<{ items: ConcernRecordTargetView[] }>(`/companions/${encodeURIComponent(companionId)}/recording-sources?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setItems(result.items) })
        .catch(() => { if (!controller.signal.aborted) { setItems([]); setError('记录位置加载失败，请重新搜索') } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [companionId, query, open])
  return <section className="dsh-partner-record-picker" aria-label="需要记录的地方">
    <label><span>需要记录的地方 · 可选</span><input value={query} aria-describedby={hint} placeholder={value ? `${value.kind === 'note' ? '笔记' : '文件'} · ${value.label}` : '搜索现有本地文件或笔记文档'} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true) }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }} /></label>
    <small id={hint} className="dsh-partner-concern-compose-hint">留空：观察结果保存在伙伴内部记录，不创建文档。选择后：另外整理到此文件或笔记；检查依据始终只读。</small>
    {value && <p className="dsh-partner-record-selection">已选择：{value.label}<button type="button" onClick={() => { onChange(undefined); setQuery('') }}>取消记录</button></p>}
    {open && <div className="dsh-partner-record-options" aria-label="可选记录位置">
      {loading ? <p role="status">正在查找…</p> : error ? <p role="alert">{error}</p> : items.length === 0 ? <p>没有可用位置，请先创建文件或笔记。</p> : items.map(item => <button type="button" key={`${item.kind}:${item.locator}`} aria-pressed={value?.kind === item.kind && value.locator === item.locator} onClick={() => { onChange(item); setQuery(''); setOpen(false) }}><small>{item.kind === 'file' ? '本地文件' : '笔记文档'}</small><span>{item.label}</span></button>)}
      <button type="button" onClick={() => setOpen(false)}>收起候选</button>
    </div>}
  </section>
}
