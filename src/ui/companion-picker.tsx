import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { IconCheckOutline14, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CompanionView } from '../client-api.js'
import { Avatar } from './partner-components.js'

/** Local, themed listbox: no platform select popup or second CSS arrow. */
export function CompanionPicker({ companions, selectedId, onChange }: {
  companions: Pick<CompanionView, 'id' | 'name' | 'role'>[]
  selectedId: string | undefined
  onChange(id: string): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = companions.find(item => item.id === selectedId) ?? companions[0]

  useEffect(() => {
    if (!open) return
    const options = list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')
    const selected = Math.max(0, companions.findIndex(item => item.id === selectedId))
    options?.[selected]?.focus({ preventScroll: true })
    options?.[selected]?.scrollIntoView({ block: 'nearest' })
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const close = (): void => setOpen(false)
    const desktop = window.matchMedia('(min-width: 761px)')
    document.addEventListener('pointerdown', outside)
    window.addEventListener('blur', close)
    desktop.addEventListener('change', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('blur', close)
      desktop.removeEventListener('change', close)
    }
  }, [open, companions, selectedId])

  const dismiss = (): void => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return }
    const options = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    options[next]?.focus({ preventScroll: true })
    options[next]?.scrollIntoView({ block: 'nearest' })
  }

  return <div className="dsh-partner-companion-picker" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="dsh-partner-companion-trigger" aria-label={`切换当前伙伴${current ? `：${current.name}` : ''}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={!current} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
    }}>
      {current && <Avatar name={current.name} small />}
      <span className="dsh-partner-companion-copy"><strong>{current?.name ?? '还没有伙伴'}</strong><small>{current?.role || '选择伙伴'}</small></span>
      <span className="dsh-partner-companion-chevron" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
    </button>
    {open && <div ref={list} id={listId} role="listbox" aria-label="选择伙伴" className="dsh-partner-companion-options" onKeyDown={navigate}>
      {companions.map(item => <button type="button" role="option" aria-selected={item.id === current?.id} tabIndex={item.id === current?.id ? 0 : -1} key={item.id} onClick={() => { dismiss(); onChange(item.id) }}>
        <Avatar name={item.name} small />
        <span className="dsh-partner-companion-copy"><strong>{item.name}</strong><small>{item.role}</small></span>
        <span className="dsh-partner-companion-check" aria-hidden="true">{item.id === current?.id && <IconCheckOutline14 size={14} />}</span>
      </button>)}
    </div>}
  </div>
}
