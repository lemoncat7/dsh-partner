import {useEffect, useRef, useState} from 'react'
import {api} from '../../client-api.js'
import {CollectionEmpty, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import type {HistoryTurn} from './types.js'

export function HistoryView({base, scopeId, query}: {base: string; scopeId: string; query: string}): JSX.Element {
  const [turns, setTurns] = useState<HistoryTurn[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [more, setMore] = useState(true)
  const [page, setPage] = useState(0)
  const cursor = useRef<HistoryTurn>()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(undefined)
    const params = new URLSearchParams({scopeId})
    if (cursor.current) {params.set('before', String(cursor.current.at)); params.set('beforeId', cursor.current.id)}
    void api<HistoryTurn[]>(`${base}/memory/history?${params}`, {signal: controller.signal}).then(items => {
      if (controller.signal.aborted) return
      setTurns(existing => [...new Map([...existing, ...items].map(turn => [turn.id, turn])).values()])
      setMore(items.length === 30); cursor.current = items.at(-1) ?? cursor.current
    }).catch(reason => {if (!controller.signal.aborted) setError(errorMessage(reason))})
      .finally(() => {if (!controller.signal.aborted) setLoading(false)})
    return () => controller.abort()
  }, [base, scopeId, page])
  const filtered = turns.filter(turn => !query || `${turn.user} ${turn.assistant}`.toLocaleLowerCase().includes(query))
  return <div className="dsh-partner-memory-records">
    <p className="dsh-partner-memory-hint">显示新版记忆流程记录的对话；旧记录仍保留在原会话中。搜索仅筛选已加载的内容。</p>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {!filtered.length && <CollectionEmpty title={loading ? '正在读取历史' : '暂无匹配的历史记录'} />}
    {filtered.map(turn => <HistoryRecord key={turn.id} turn={turn} />)}
    {(more || error) && <button type="button" disabled={loading} onClick={() => setPage(value => value + 1)}>{loading ? '读取中…' : error ? '重试读取' : '加载更早的 30 轮'}</button>}
  </div>
}

function HistoryRecord({turn}: {turn: HistoryTurn}): JSX.Element {
  const [open, setOpen] = useState(false)
  return <details className="dsh-partner-memory-record" onToggle={event => setOpen(event.currentTarget.open)}><summary><time>{new Date(turn.at).toLocaleString()}</time><strong>{turn.user.slice(0, 120)}</strong></summary>{open && <div><h3>用户原话</h3><p>{turn.user}</p><h3>助手当时的回答</h3><p>{turn.assistant}</p><small>历史回答不代表当前已验证的事实。</small></div>}</details>
}
