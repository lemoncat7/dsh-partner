import { IdleContactEditor } from './idle-contact-editor.js'
import { SettingsSections } from './settings-sections.js'
import { CharacterEditor } from './character-editor.js'
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
  const [section, setSection] = useState<'identity' | 'character' | 'idle'>('identity')
  const dirty = useRef(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!dirty.current) setForm(companionDraft(companion)) }, [companion.updatedAt])
  const busy = operation !== undefined
  const edit = (value: typeof form) => { setForm(value); dirty.current = true; setSaved(false) }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked.current) return
    locked.current = true; setOperation('save'); setError(undefined)
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(companion.id)}`, { method: 'PUT', body: JSON.stringify({ companion: { ...companionDraft(companion), ...(form.idleContact ? {idleContact: form.idleContact} : {}), name: form.name, role: form.role, description: form.description, instructions: form.instructions, ...(form.characterCard ? {characterCard: form.characterCard} : {}) } }) })
      committed = true
      dirty.current = false
      await onChanged()
      if (alive.current) setSaved(true)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '身份已保存，但刷新失败，无需重复保存：' : '保存失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setOperation(undefined) }
  }
  return <form onInvalidCapture={event => { event.preventDefault(); const target = event.target as HTMLElement; const idle = Boolean(target.closest('[aria-label="闲时主动联系"]')); setSection(idle ? 'idle' : 'identity'); setError(idle ? '请选择闲时联系的目标会话。' : '请填写基本身份中的名字和角色。'); requestAnimationFrame(() => target.focus()) }} id="dsh-partner-identity-editor" className="dsh-partner-form is-identity" aria-busy={operation !== undefined} onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="身份与角色" detail="基本身份管理名字与职责，角色聊天管理个性与接话方式。分段编辑，统一保存。" />
    <section className="dsh-partner-identity-card" aria-label="身份配置">
    <SettingsSections<typeof section> label="身份设置分段" value={section} onChange={setSection} sections={[{id: 'identity', title: '基本身份', detail: '名字、定位与行为准则', content: <>
    <div className="dsh-partner-fields two"><Field label="名字"><input disabled={busy} required maxLength={60} value={form.name} onChange={event => edit({ ...form, name: event.target.value })} /></Field><Field label="角色"><input disabled={busy} required maxLength={120} value={form.role} onChange={event => edit({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea disabled={busy} rows={2} maxLength={500} value={form.description} onChange={event => edit({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="建议写职责、表达方式与边界；渠道、工具和授权由系统单独控制。"><textarea disabled={busy} rows={9} maxLength={12000} value={form.instructions} onChange={event => edit({ ...form, instructions: event.target.value })} /></Field>
    </>}, {id: 'character', title: '角色聊天', detail: form.characterCard?.enabled ? '已启用 · 设定与试聊' : '可选 · 设定与试聊', content: <CharacterEditor companion={companion} {...(form.characterCard ? {card:form.characterCard} : {})} disabled={busy} onChange={characterCard => edit({...form,characterCard})} />}, {id: 'idle', title: '闲时主动联系', detail: form.idleContact?.enabled ? '已开启 · 空闲时来聊聊' : '可选 · 不打扰地联系', content: <IdleContactEditor companionId={companion.id} value={form.idleContact} disabled={busy} onChange={idleContact => edit({...form,idleContact})} />}]} />
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    <div className="dsh-partner-form-actions"><span role="status">{saved && <><IconCheckOutline14 size={14} />已保存，下一轮将使用新身份</>}</span><button disabled={busy}>{operation === 'save' ? '正在保存…' : '保存身份'}</button></div>
    </section>
  </form>
}
