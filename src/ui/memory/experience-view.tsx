import {useRef, useState} from 'react'
import {api} from '../../client-api.js'
import {WorkspaceDialog, WorkspaceNotice, CollectionEmpty, errorMessage} from '../workspace-components.js'
import type {ExperienceView as Draft} from './types.js'

export function ExperienceView({items, base, scopeId, changed}: {items: Draft[]; base: string; scopeId: string; changed(): Promise<void>}): JSX.Element {
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [filter, setFilter] = useState<Draft['status']>('draft')
  const item = items.find(entry => entry.id === selected)
  const review = async (action: 'approved' | 'rejected' | 'export'): Promise<void> => {
    if (!item || lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    const path = `${base}/memory/experiences/${encodeURIComponent(item.id)}?${new URLSearchParams({scopeId})}`
    try {
      if (action === 'export') {
        const {document} = await api<{document: string}>(path)
        const url = URL.createObjectURL(new Blob([document], {type: 'text/markdown;charset=utf-8'}))
        const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `${item.id}.md`; window.document.body.append(anchor); anchor.click(); anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setNotice('已导出草稿；不会自动安装或授权给伙伴')
      } else {
        await api(path, {method: 'POST', body: JSON.stringify({action, version: item.version})})
        setSelected(undefined); setNotice(action === 'approved' ? '已通过审核，可在已通过列表中导出' : '已拒绝此草稿')
        await changed()
      }
    } catch (reason) {setError(errorMessage(reason)); await changed()}
    finally {lock.current = false; setBusy(false)}
  }
  return <>
    <p className="dsh-partner-memory-hint">从有成功依据的经历中提炼。审核通过后仅允许导出，不会自动安装 Skill。</p>
    {notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    <div className="dsh-partner-memory-segment" aria-label="经验状态">{(['draft', 'approved', 'rejected'] as const).map(status => <button type="button" aria-pressed={filter === status} key={status} onClick={() => setFilter(status)}>{({draft: '待审核', approved: '已通过', rejected: '已拒绝'})[status]} <small>{items.filter(draft => draft.status === status).length}</small></button>)}</div>
    <div className="dsh-partner-memory-rows">{items.filter(draft => draft.status === filter).map(draft => <button className="dsh-partner-memory-row" type="button" key={draft.id} onClick={() => {setSelected(draft.id); setError(undefined)}}><span><strong>{draft.title}</strong><small>{draft.steps.length} 个步骤 · {draft.evidence.length} 处依据</small></span><small>查看</small></button>)}</div>
    {!items.some(draft => draft.status === filter) && <CollectionEmpty title="没有此状态的经验草稿" detail="只有明确成功且可复用的经历才会成为候选；需要开启每日终审。" />}
    {item && <WorkspaceDialog title={item.title} detail="请核对适用范围、操作步骤及成功依据；历史成功不代表每次都适用。" close={() => {if (!busy) setSelected(undefined)}}>
      {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
      <ol className="dsh-partner-memory-procedure">{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      <details className="dsh-partner-memory-record"><summary>成功依据 · {item.evidence.length}</summary><div>{item.evidence.map(source => <blockquote key={`${source.turnId}:${source.quote}`}><p>{source.quote}</p><small>{source.turnId}</small></blockquote>)}</div></details>
      <footer className="dsh-partner-memory-actions">{item.status === 'draft' ? <><button type="button" disabled={busy} onClick={() => {void review('rejected')}}>拒绝</button><button className="is-primary" type="button" disabled={busy} onClick={() => {void review('approved')}}>{busy ? '处理中…' : '通过审核'}</button></> : item.status === 'approved' ? <button type="button" disabled={busy} onClick={() => {void review('export')}}>{busy ? '导出中…' : '导出 Markdown'}</button> : <span>此草稿已拒绝，不会自动启用。</span>}</footer>
    </WorkspaceDialog>}
  </>
}
