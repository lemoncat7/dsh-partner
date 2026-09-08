import {useEffect, useId, useRef, useState, type FormEvent} from 'react'
import {IconCheckOutline14, IconChevronDownOutline14, IconPlusOutline16, IconLinkOutline16, IconDataOutline16} from '@deepseek-ai/dsh-client-ui-primitives'
import {api, type ConcernActivityView, type ConcernView, type ConcernSourceView, type ConcernObservationView} from '../../client-api.js'
import {futureTime} from '../../time-format.js'
import {errorMessage as message} from '../workspace-components.js'
export function ConcernBoard({ companionId, activity, value, busy, onValue, onAdd, onCheck, onAct }: {
  companionId: string; activity: ConcernActivityView; value: string; busy: boolean; onValue(value: string): void; onAdd(): void
  onCheck(item: ConcernView): void
  onAct(item: ConcernView, action: 'watch' | 'ignore' | 'prioritize' | 'resolve'): void
}): JSX.Element {
  const visible = activity.concerns.filter(item => item.state !== 'archived')
  const active = visible.filter(item => item.state !== 'resolved')
  const resolved = visible.filter(item => item.state === 'resolved')
  const latest = new Map([...activity.observations].reverse().map(item => [item.concernId, item]))
  const [composing, setComposing] = useState(false)
  const [expandedId, setExpandedId] = useState<string>()
  const [visibleCount, setVisibleCount] = useState(5)
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [sources, setSources] = useState<ConcernSourceView[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string>()
  const [activeSource, setActiveSource] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const shown = active.slice(0, visibleCount)
  const suggestionsOpen = composing && mention !== undefined
  useEffect(() => {
    if (!suggestionsOpen || mention === undefined) {
      setSources([]); setSourcesLoading(false); setSourceError(undefined); return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSourcesLoading(true); setSourceError(undefined)
      const params = new URLSearchParams({ q: mention.query })
      void api<{ items: ConcernSourceView[] }>(`/companions/${encodeURIComponent(companionId)}/concern-sources?${params}`, {signal: controller.signal}).then(result => {
        if (!controller.signal.aborted) { setSources(result.items); setActiveSource(0) }
      }).catch(reason => {
        if (!controller.signal.aborted) { setSources([]); setSourceError(message(reason)) }
      }).finally(() => { if (!controller.signal.aborted) setSourcesLoading(false) })
    }, 150)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [companionId, mention?.query, suggestionsOpen])
  const submit = (event: FormEvent): void => { event.preventDefault(); onAdd(); setComposing(false); setMention(undefined) }
  const chooseSource = (source: ConcernSourceView): void => {
    if (mention === undefined) return
    const next = `${value.slice(0, mention.start)}${source.token} ${value.slice(mention.end)}`
    const cursor = mention.start + source.token.length + 1
    onValue(next); setMention(undefined); setSources([])
    window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor, cursor) })
  }
  return <section className="dsh-partner-concern-board" aria-labelledby="partner-concerns-title">
    <header><span><strong id="partner-concerns-title">伙伴在意的事 <b>{active.length}</b></strong><p>尚未闭环、值得继续留意的事情</p></span><button type="button" aria-expanded={composing} onClick={() => setComposing(current => !current)}><IconPlusOutline16 size={14} />交代一件事</button></header>
    {composing && <form className="dsh-partner-concern-compose" onSubmit={submit}><label><span>需要留意的事</span><div className="dsh-partner-concern-input-wrap"><input
      ref={inputRef} autoFocus value={value} maxLength={300} placeholder="输入 @ 选择文件或知识文档"
      role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen} aria-controls={suggestionsOpen ? listboxId : undefined}
      aria-activedescendant={suggestionsOpen && sources[activeSource] ? `${listboxId}-option-${activeSource}` : undefined}
      onChange={event => { onValue(event.target.value); setMention(activeMention(event.target.value, event.target.selectionStart ?? event.target.value.length)) }}
      onClick={event => setMention(activeMention(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length))}
      onKeyDown={event => {
        if (!suggestionsOpen) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActiveSource(index => sources.length === 0 ? 0 : (index + 1) % sources.length) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveSource(index => sources.length === 0 ? 0 : (index - 1 + sources.length) % sources.length) }
        else if (event.key === 'Enter' && sources[activeSource]) { event.preventDefault(); chooseSource(sources[activeSource]) }
        else if (event.key === 'Escape') { event.preventDefault(); setMention(undefined) }
      }}
    />{suggestionsOpen && <div id={listboxId} className="dsh-partner-concern-sources" role="listbox" aria-label="可引用的文件与知识文档">
      {sourcesLoading ? <p role="status">正在查找可引用内容…</p> : sourceError ? <p role="status">候选加载失败：{sourceError}</p> : sources.length === 0 ? <p role="status">没有找到匹配的文件或已挂载知识文档</p> : <>
        {sources.map((source, index) => <button
          type="button" role="option" id={`${listboxId}-option-${index}`} key={`${source.kind}:${source.token}`}
          aria-selected={index === activeSource} data-kind={source.kind} onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => setActiveSource(index)} onClick={() => chooseSource(source)}
        ><span>{source.kind === 'file' ? <IconDataOutline16 size={15} /> : <IconLinkOutline16 size={15} />}</span><strong>{source.label}</strong><small>{source.detail}</small></button>)}
      </>}
    </div>}</div><small className="dsh-partner-concern-compose-hint">输入 <b>@</b> 会列出当前会话文件和已挂载的知识文档，也可以继续输入关键词筛选。</small></label><div><button type="button" onClick={() => { setComposing(false); setMention(undefined); onValue('') }}>取消</button><button type="submit" className="is-primary" disabled={busy || !value.trim()}>让伙伴记着</button></div></form>}
    <div className="dsh-partner-concern-list" role="list">
      {active.length === 0 ? <p className="dsh-partner-concern-empty">最近没有未闭环的事。你也可以直接对伙伴说“这个帮我留意”。</p> : shown.map(item => {
        const observation = latest.get(item.id)
        const expanded = expandedId === item.id
        const status = observation ? concernObservationStatus(observation) : item.state === 'active' ? '正在留意' : '暂时记着'
        return <article key={item.id} role="listitem" data-state={item.state} data-expanded={expanded}>
          <button type="button" className="dsh-partner-concern-row" aria-expanded={expanded} onClick={() => setExpandedId(current => current === item.id ? undefined : item.id)}>
            <span className="dsh-partner-concern-state"><i />{status}</span><span className="dsh-partner-concern-copy"><strong>{item.subject}</strong><small>{observation ? observation.event : item.reason}</small></span><span className="dsh-partner-concern-time" title={`计划于 ${new Date(item.nextCheckAt).toLocaleString()} 再次留意`}><small>下次留意</small><strong>{futureTime(item.nextCheckAt)}</strong></span><IconChevronDownOutline14 size={14} />
          </button>
          {expanded && <div className="dsh-partner-concern-detail"><p>{item.reason}</p>{observation && <><blockquote>{observation.event}</blockquote><div className="dsh-partner-concern-decision" data-decision={observation.decision}><strong>{concernObservationStatus(observation)}</strong><span>{observation.decisionReason || concernObservationExplanation(observation)}</span><small>打扰分数 {Math.round(observation.interruptScore * 100)}{observation.notificationRuleEffect !== 'auto' && observation.notificationRuleReason ? ` · 知识规则：${observation.notificationRuleReason}` : ''}</small></div></>}{item.resources.length > 0 && <div className="dsh-partner-concern-resources">{item.resources.map(resource => <span key={`${resource.kind}:${resource.locator}`}>{resource.kind === 'file' ? '文件' : '知识'} · {resource.label}</span>)}</div>}<small>{item.origin === 'explicit' ? '你明确交代' : '伙伴从对话中注意到'} · {watchKindLabel(item.watchKind)}</small><div className="dsh-partner-concern-actions" aria-label={`${item.subject} 的操作`}><button type="button" disabled={busy} onClick={() => onCheck(item)}>立即检查这条</button><button type="button" disabled={busy} onClick={() => onAct(item, 'watch')}>继续留意</button><button type="button" disabled={busy} onClick={() => onAct(item, 'prioritize')}>提高关注</button><button type="button" disabled={busy} onClick={() => onAct(item, 'resolve')}>已经解决</button><button type="button" className="is-danger" disabled={busy} onClick={() => onAct(item, 'ignore')}>别管这个</button></div></div>}
        </article>
      })}
    </div>
    {(active.length > shown.length || visibleCount > 5) && <div className="dsh-partner-concern-more">{active.length > shown.length ? <button type="button" onClick={() => setVisibleCount(count => Math.min(active.length, count + 20))}>再显示 {Math.min(20, active.length - shown.length)} 条</button> : <button type="button" onClick={() => setVisibleCount(5)}>收起列表</button>}</div>}
    {resolved.length > 0 && <details className="dsh-partner-concern-resolved"><summary>已经解决 <b>{resolved.length}</b></summary><div>{resolved.slice(0, 30).map(item => <article key={item.id}><span><IconCheckOutline14 size={13} /></span><strong>{item.subject}</strong><button type="button" disabled={busy} onClick={() => onAct(item, 'watch')}>重新留意</button></article>)}</div></details>}
  </section>
}

function activeMention(value: string, cursor: number): { start: number; end: number; query: string } | undefined {
  const prefix = value.slice(0, cursor)
  const start = prefix.lastIndexOf('@')
  if (start < 0 || (start > 0 && !/\s/u.test(prefix[start - 1] ?? ''))) return undefined
  const fragment = prefix.slice(start + 1)
  if (fragment.startsWith('知识库[')) {
    if (fragment.includes(']')) return undefined
    return { start, end: cursor, query: fragment.slice(4) }
  }
  if (fragment.startsWith('"')) {
    if (fragment.slice(1).includes('"')) return undefined
    return { start, end: cursor, query: fragment.slice(1) }
  }
  if (/\s/u.test(fragment)) return undefined
  return { start, end: cursor, query: fragment }
}

function watchKindLabel(value: ConcernView['watchKind']): string {
  return value === 'knowledge' ? '知识库变化' : value === 'workspace' ? '项目变化' : value === 'web' ? '外部变化' : '按事情判断来源'
}

function concernObservationStatus(item: ConcernObservationView): string {
  if (item.decision === 'notify') return item.mentionedAt === undefined ? '待提醒' : '已提醒'
  if (item.decision === 'feed') return '伙伴动态'
  if (item.decision === 'defer') return item.mentionedAt === undefined ? '待顺带提' : '已顺带提'
  return '静默记下'
}
function concernObservationExplanation(item: ConcernObservationView): string {
  if (item.decision === 'notify') return item.mentionedAt === undefined ? '达到主动提醒条件，等待渠道投递' : '已经通过批准的渠道主动提醒'
  if (item.decision === 'feed') return '只显示在伙伴动态，不会自动转成主动提醒'
  if (item.decision === 'defer') return item.mentionedAt === undefined ? '下次出现相关对话时顺带提及' : '已经在相关对话中顺带提及'
  return '仅保留为观察记录，不打扰你'
}
