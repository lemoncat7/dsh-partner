import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IconCheckOutlineRegular as IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView } from '../client-api.js'
import { companionDraft } from './companion-draft.js'
import { FormField as Field, SectionHeading as Section } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

interface Props {
  companion: CompanionView
  onChanged(): Promise<void>
}

/** Identity-scoped lifetime prevents confirmations and late results crossing targets. */
export function IdentityEditor(props: Props): JSX.Element { return <IdentityEditorForm key={props.companion.id} {...props} /> }

function IdentityEditorForm({ companion, onChanged }: Props): JSX.Element {
  const [form, setForm] = useState(() => companionDraft(companion))
  const [operation, setOperation] = useState<'save'>()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setForm(companionDraft(companion)); setSaved(false) }, [companion.updatedAt])
  const busy = operation !== undefined
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked.current) return
    locked.current = true; setOperation('save'); setError(undefined)
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(companion.id)}`, { method: 'PUT', body: JSON.stringify({ companion: form }) })
      committed = true
      await onChanged()
      if (alive.current) setSaved(true)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '身份已保存，但刷新失败，无需重复保存：' : '保存失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setOperation(undefined) }
  }
  return <form id="dsh-partner-identity-editor" className="dsh-partner-form is-identity" aria-busy={operation !== undefined} onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="工作身份" detail="它不是一次对话的提示词，而是这个伙伴在桌面和微信中的长期行为基线。" />
    <section className="dsh-partner-identity-card" aria-label="身份配置">
    <div className="dsh-partner-fields two"><Field label="名字"><input disabled={busy} required maxLength={60} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field><Field label="角色"><input disabled={busy} required maxLength={120} value={form.role} onChange={event => setForm({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea disabled={busy} rows={2} maxLength={500} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="建议写职责、表达方式与边界；渠道、工具和授权由系统单独控制。"><textarea disabled={busy} rows={9} maxLength={12000} value={form.instructions} onChange={event => setForm({ ...form, instructions: event.target.value })} /></Field>
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    <div className="dsh-partner-form-actions"><span role="status">{saved && <><IconCheckOutline14 size={14} />已保存，下一轮将使用新身份</>}</span><button disabled={busy}>{operation === 'save' ? '正在保存…' : '保存身份'}</button></div>
    </section>
  </form>
}
