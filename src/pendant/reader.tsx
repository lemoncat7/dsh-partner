import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { IconCheckOutline14, IconChevronDownOutline14, IconCloseOutline16, IconLinkOutline16, IconNewChatOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PartnerInbox, PartnerNotice } from '../notifications/domain.js'
import { readerPlacement } from './use-placement.js'

interface Props {
  inbox: PartnerInbox; selected: string | undefined; error: string; anchor: RefObject<HTMLButtonElement>
  onSelect(item?: PartnerNotice): void; onClose(keyboard?: boolean): void; onVisit(item: PartnerNotice): void; onReadAll(): void
}
export function PendantReader({ inbox, selected, error, anchor, onSelect, onClose, onVisit, onReadAll }: Props): JSX.Element {
  const panel = useRef<HTMLElement>(null), [visible, setVisible] = useState(8)
  const measure = () => readerPlacement(anchor.current?.getBoundingClientRect() ?? { x: innerWidth / 2, y: 16, width: 0, height: 0 }, { width: innerWidth, height: innerHeight })
  const [placement, setPlacement] = useState(measure)
  const detail = inbox.items.find(item => item.id === selected)
  useLayoutEffect(() => {
    setPlacement(measure())
    panel.current?.focus({ preventScroll: true })
    let frame = 0
    const resize = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setPlacement(measure())) }
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize) }
  }, [anchor])
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      // The card remains an operable toggle; do not close on pointerdown and
      // accidentally reopen on its pointerup. Dragging it is still playable.
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [onClose, anchor])
  return <section ref={panel} id="dsh-partner-pendant-inbox" className="dsh-partner-pendant-inbox" aria-label="伙伴消息" tabIndex={-1} style={placement}>
    <header>
      {detail && <button type="button" aria-label="返回消息列表" onClick={() => onSelect()}><IconChevronDownOutline14 size={16} className="dsh-partner-pendant-back" /></button>}
      {!detail && <span className="dsh-partner-pendant-reader-icon" aria-hidden="true"><IconNewChatOutline16 size={18} /></span>}
      <div className="dsh-partner-pendant-reader-heading"><strong>{detail ? detail.companionName : '伙伴消息'}</strong><small>{detail ? '来自伙伴的消息' : '回复与任务动态'}</small></div>
      {!!inbox.unread && <span className="dsh-partner-pendant-reader-count" aria-label={`${inbox.unread} 条未读`}>{inbox.unread}</span>}
      <button type="button" aria-label="关闭伙伴消息" onClick={event => onClose(event.detail === 0)}><IconCloseOutline16 size={16} /></button>
    </header>
    {error && <p role="alert" className="dsh-partner-pendant-error">{error}</p>}
    {detail ? <><article className="dsh-partner-pendant-detail"><div className="dsh-partner-pendant-reader-meta"><span>{detail.kind === 'task' ? '任务动态' : detail.kind === 'schedule' ? '定时任务' : '会话回复'}</span><time dateTime={new Date(detail.createdAt).toISOString()}>{new Date(detail.createdAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div><h3>{detail.title}</h3><p>{detail.summary}</p></article><footer><button type="button" className="dsh-partner-pendant-all-messages" onClick={() => onSelect()}>全部消息<span>{inbox.items.length}</span></button><button type="button" className="dsh-partner-pendant-source" onClick={() => onVisit(detail)}><IconLinkOutline16 size={15} />{detail.kind === 'task' ? '查看任务' : detail.kind === 'schedule' ? '查看定时任务' : '进入会话'}</button></footer></>
      : <><div className="dsh-partner-pendant-list">{inbox.items.length ? inbox.items.slice(0, visible).map(item => <button type="button" key={item.id} data-unread={item.readAt === undefined} onClick={() => onSelect(item)}><span><strong>{item.companionName}</strong><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span><b>{item.title}</b><small>{item.summary.replace(/\s+/g, ' ').slice(0, 100)}</small></button>) : <p className="dsh-partner-pendant-empty">暂时没有新消息</p>}{inbox.items.length > visible && <button type="button" onClick={() => setVisible(count => count + 8)}>显示更多消息</button>}</div><footer><small>最近 {inbox.items.length} 条</small><button type="button" disabled={!inbox.unread} onClick={onReadAll}><IconCheckOutline14 size={14} />全部已读</button></footer></>}
  </section>
}
