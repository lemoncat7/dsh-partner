import { useCallback, useEffect, useRef, useState } from 'react'
import { PARTNER_API } from '../client-api.js'
import type { PartnerNotice } from '../notifications/domain.js'
import type { PartnerController } from '../client-controller.js'
import type { BadgeMessage, LanyardHandle, LanyardOptions } from './renderer.js'
import { usePartnerInbox } from './use-inbox.js'
import { usePendantPlacement } from './use-placement.js'
import { PendantReader } from './reader.js'
import { usePendantSettings } from './use-settings.js'
import type { PendantSettings } from './settings.js'

function messageLabel(notice: PartnerNotice): string {
  if (notice.kind === 'reply') return '有新回复'
  if (notice.kind === 'task' && notice.title.startsWith('遇到阻塞 · ')) return '任务受阻'
  if (notice.kind === 'schedule' && notice.title.startsWith('未完成 · ')) return '尚未完成'
  return notice.kind === 'task' ? '任务完成' : '定时完成'
}

export function PartnerPendant({ controller }: { controller: PartnerController }): JSX.Element | null {
  const settings = usePendantSettings()
  return settings.enabled ? <ActivePendant controller={controller} settings={settings} /> : null
}

function ActivePendant({ controller, settings }: { controller: PartnerController; settings: PendantSettings }): JSX.Element {
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), hit = useRef<HTMLButtonElement>(null)
  const unreadBadge = useRef<HTMLSpanElement>(null)
  const handle = useRef<LanyardHandle>(), toggle = useRef(() => {})
  const [open, setOpen] = useState(false), [ready, setReady] = useState(false), [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string>(), [navigationError, setNavigationError] = useState('')
  const { inbox, incoming, error, read } = usePartnerInbox()
  const latestUnread = inbox.items.find(item => item.readAt === undefined)
  const badgeMessage: BadgeMessage | undefined = latestUnread ? { id: latestUnread.id, count: inbox.unread, name: latestUnread.companionName, label: messageLabel(latestUnread) } : undefined
  const messageRef = useRef(badgeMessage)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  messageRef.current = badgeMessage
  const placement = usePendantPlacement(root, handle)
  const close = useCallback((keyboard = false): void => {
    setOpen(false)
    if (keyboard) requestAnimationFrame(() => hit.current?.focus({ preventScroll: true }))
  }, [])
  const inspect = (item?: PartnerNotice): void => { setSelected(item?.id); if (item && item.readAt === undefined) void read([item.id]) }
  toggle.current = () => {
    if (open) { close(); return }
    setNavigationError(''); inspect(latestUnread); setOpen(true)
  }
  useEffect(() => {
    const abort = new AbortController()
    const url = `${PARTNER_API}/pendant/renderer.js`
    void import(/* @vite-ignore */ url).then(async (module: { createLanyard(canvas: HTMLCanvasElement, hit: HTMLButtonElement, options: LanyardOptions): Promise<LanyardHandle> }) => {
      if (abort.signal.aborted || !canvas.current || !hit.current) return
      const instance = await module.createLanyard(canvas.current, hit.current, {
        signal: abort.signal, onTap: () => toggle.current(), onFailure: () => { handle.current?.destroy(); handle.current = undefined; setReady(false); setFailed(true) },
        ...(unreadBadge.current ? { unreadBadge: unreadBadge.current } : {}),
      })
      if (abort.signal.aborted) { instance.destroy(); return }
      handle.current = instance; instance.setAppearance(settingsRef.current); instance.setMessage(messageRef.current); setReady(true)
    }).catch(() => { if (!abort.signal.aborted) { setFailed(true); setReady(false) } })
    return () => { abort.abort(); handle.current?.destroy(); handle.current = undefined }
  }, [])
  useEffect(() => { handle.current?.setMessage(badgeMessage) }, [inbox, ready])
  useEffect(() => { handle.current?.setAppearance(settings) }, [settings, ready])
  const visit = async (item: PartnerNotice): Promise<void> => {
    setNavigationError('')
    try {
      if (item.routeId && item.sessionId) await controller.openSession(item.routeId, item.sessionId)
      else controller.open(item.companionId, { page: item.kind === 'task' ? 'board' : item.kind === 'schedule' ? 'schedules' : 'home', ...(item.taskId ? { taskId: item.taskId } : {}) })
      close()
    } catch (reason) { setNavigationError(reason instanceof Error ? reason.message : '无法打开来源') }
  }
  const label = `伙伴消息，${inbox.unread} 条未读${latestUnread ? `，${latestUnread.companionName}：${latestUnread.title}` : ''}；点击查看，拖动卡牌玩耍`
  return <aside ref={root} className="dsh-partner-pendant" aria-label="伙伴挂饰">
    <canvas ref={canvas} className="dsh-partner-pendant-canvas" aria-hidden="true" />
    <button ref={hit} type="button" className={`dsh-partner-pendant-hit${ready ? ' is-rendered' : ''}`} aria-label={label} aria-expanded={open} aria-controls={open ? 'dsh-partner-pendant-inbox' : undefined} onClick={() => { if (!ready) toggle.current() }}>
      {!ready && <span className="dsh-partner-pendant-fallback">伙伴<small>{failed ? inbox.unread ? `${inbox.unread} 条消息` : '消息' : '加载挂饰…'}</small></span>}
    </button>
    <button type="button" className="dsh-partner-pendant-anchor" aria-label="移动挂饰位置" title="拖动挂点移动位置，也可用方向键微调" {...placement}><span aria-hidden="true" /></button>
    <span ref={unreadBadge} className="dsh-partner-pendant-unread" hidden={inbox.unread === 0} aria-hidden="true">{inbox.unread > 99 ? '99+' : inbox.unread}</span>
    <span className="dsh-partner-pendant-announcement" role="status" aria-live="polite" aria-atomic="true">{incoming ? `${incoming.companionName}：${incoming.title}` : ''}</span>
    {open && <PendantReader inbox={inbox} selected={selected} error={error || navigationError} anchor={hit} onSelect={inspect} onClose={close} onVisit={item => { void visit(item) }} onReadAll={() => { void read(inbox.items.filter(item => item.readAt === undefined).map(item => item.id)) }} />}
  </aside>
}
