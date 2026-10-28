import { useId, useRef, type ReactNode } from 'react'

/** Keep panels mounted so switching sections never discards drafts or trial history. */
export function SettingsSections<T extends string>({ label, value, onChange, sections }: {
  label: string
  value: T
  onChange(value: T): void
  sections: Array<{ id: T; title: string; detail?: string; content: ReactNode }>
}): JSX.Element {
  const id = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  return <div className="dsh-partner-settings-sections">
    <div role="tablist" aria-label={label} className="dsh-partner-settings-tabs">
      {sections.map((section, index) => <button key={section.id} type="button" role="tab"
        id={`${id}-tab-${section.id}`} aria-controls={`${id}-panel-${section.id}`}
        aria-selected={value === section.id} tabIndex={value === section.id ? 0 : -1}
        ref={element => { buttons.current[index] = element }}
        onClick={() => onChange(section.id)} onKeyDown={event => {
          const target = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
            : event.key === 'ArrowRight' ? (index + 1) % sections.length
              : event.key === 'ArrowLeft' ? (index - 1 + sections.length) % sections.length : undefined
          if (target === undefined) return
          event.preventDefault(); onChange(sections[target]!.id); buttons.current[target]?.focus()
        }}><span>{section.title}</span>{section.detail && <small>{section.detail}</small>}</button>)}
    </div>
    {sections.map(section => <section key={section.id} role="tabpanel" tabIndex={0}
      id={`${id}-panel-${section.id}`} aria-labelledby={`${id}-tab-${section.id}`}
      hidden={value !== section.id} className="dsh-partner-settings-panel">{section.content}</section>)}
  </div>
}
