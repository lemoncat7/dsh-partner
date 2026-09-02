import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { IconAgentPresetOutline16, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

export function WorkspaceHero({ eyebrow, title, detail, actions }: { eyebrow: string; title: string; detail: string; actions?: ReactNode }): JSX.Element {
  return <header className="dsh-partner-feature-hero">
    <span><small>{eyebrow}</small><h2>{title}</h2><p>{detail}</p></span>
    {actions && <div className="dsh-partner-feature-hero-actions">{actions}</div>}
  </header>
}

export function WorkspaceBlock({ title, detail, actions, children, className = '' }: { title: string; detail?: string; actions?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return <section className={`dsh-partner-feature-block${className ? ` ${className}` : ''}`}>
    <header><span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{actions && <div>{actions}</div>}</header>
    {children}
  </section>
}

export function WorkspaceDialog({ title, detail, close, children, width = 'regular' }: { title: string; detail: string; close(): void; children: ReactNode; width?: 'regular' | 'wide' }): JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      const target = panel?.querySelector<HTMLElement>('[autofocus]') ?? panel?.querySelector<HTMLElement>('input, textarea, select, button')
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame); previous?.focus() }
  }, [])
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    if (focusable.length === 0) return
    const first = focusable[0]; const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className="dsh-partner-workspace-dialog-layer" onPointerDown={event => { if (event.target === event.currentTarget) close() }}>
    <section ref={panelRef} className={`dsh-partner-workspace-dialog is-${width}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keyDown}>
      <header><span><small>CREATE &amp; CONFIGURE</small><strong id={titleId}>{title}</strong><p>{detail}</p></span><button type="button" onClick={close} aria-label="关闭"><IconCloseOutline16 size={16} /></button></header>
      <div className="dsh-partner-workspace-dialog-body">{children}</div>
    </section>
  </div>
}

export function WorkspaceNotice({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'warning' | 'success' }): JSX.Element {
  return <p className={`dsh-partner-workspace-notice is-${kind}`} role={kind === 'error' ? 'alert' : 'status'}><i />{children}</p>
}

export function CollectionEmpty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }): JSX.Element {
  return <div className="dsh-partner-collection-empty"><span><IconAgentPresetOutline16 size={18} /></span><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>
}

export function CollectionSkeleton({ rows = 3 }: { rows?: number }): JSX.Element {
  return <div className="dsh-partner-collection-skeleton" aria-label="正在加载" aria-busy="true">{Array.from({ length: rows }, (_, index) => <i key={index} />)}</div>
}

export function CountLabel({ value, label }: { value: number; label: string }): JSX.Element {
  return <span className="dsh-partner-count-label"><b>{value}</b>{label}</span>
}

export function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value) }
