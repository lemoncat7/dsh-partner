import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IconCheckOutline14, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView } from '../client-api.js'
import { companionDraft } from './companion-draft.js'
import { FormField as Field, SectionHeading as Section } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

interface Props {
  companion: CompanionView
  count: number
  onChanged(): Promise<void>
  onRemoved(id: string): Promise<void>
}

/** Identity-scoped lifetime prevents confirmations and late results crossing targets. */
export function IdentityEditor(props: Props): JSX.Element { return <IdentityEditorForm key={props.companion.id} {...props} /> }

function IdentityEditorForm({ companion, count, onChanged, onRemoved }: Props): JSX.Element {
  const [form, setForm] = useState(() => companionDraft(companion))
  const [operation, setOperation] = useState<'save' | 'remove'>()
  const [saved, setSaved] = useState(false)
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmationId, setConfirmationId] = useState<string>()
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setForm(companionDraft(companion)); setSaved(false); setConfirmationId(undefined) }, [companion.updatedAt])
  const confirming = confirmationId === companion.id
  const busy = operation !== undefined || removed
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked.current || removed) return
    locked.current = true; setOperation('save'); setError(undefined); setConfirmationId(undefined)
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
  const remove = async (): Promise<void> => {
    if (locked.current || removed || !confirming || count <= 1) return
    const targetId = confirmationId
    locked.current = true; setOperation('remove'); setError(undefined); setConfirmationId(undefined)
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(targetId)}?removeFiles=1`, { method: 'DELETE' })
      committed = true
      if (alive.current) setRemoved(true)
      // Always refresh the parent even if the user switched away during deletion.
      await onRemoved(targetId)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '伙伴已删除，但页面刷新失败，请刷新页面，不要再次删除：' : '删除失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setOperation(undefined) }
  }
  return <form className="dsh-partner-form is-identity" aria-busy={operation !== undefined} onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="工作身份" detail="它不是一次对话的提示词，而是这个伙伴在桌面和微信中的长期行为基线。" />
    <div className="dsh-partner-fields two"><Field label="名字"><input disabled={busy} required maxLength={60} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field><Field label="角色"><input disabled={busy} required maxLength={120} value={form.role} onChange={event => setForm({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea disabled={busy} rows={2} maxLength={500} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="建议写职责、表达方式与边界；渠道、工具和授权由系统单独控制。"><textarea disabled={busy} rows={9} maxLength={12000} value={form.instructions} onChange={event => setForm({ ...form, instructions: event.target.value })} /></Field>
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    <div className="dsh-partner-form-actions"><span role="status">{saved && <><IconCheckOutline14 size={14} />已保存，下一轮将使用新身份</>}</span><button disabled={busy}>{operation === 'save' ? '正在保存…' : '保存身份'}</button></div>
    <div className="dsh-partner-identity-danger" data-confirming={confirming}>
      <span><strong>{removed ? '伙伴已删除' : confirming ? `确认删除「${companion.name}」？` : '删除伙伴'}</strong><small>{confirming ? '将删除该伙伴的配置、记忆、挂念、专属目录及其中全部文件，此操作不可撤销。共享或异常目录会拦截；DSH 原会话日志仍由宿主管理，不在此次清理范围内。' : '必须先解绑微信并结束运行中的任务。删除只针对本次确认的伙伴，不会转交联系人。'}</small></span>
      <div>{confirming && <button type="button" disabled={busy} className="is-secondary" onClick={() => setConfirmationId(undefined)}>取消</button>}<button type="button" className={confirming ? 'is-danger' : ''} disabled={busy || count <= 1} onClick={() => confirming ? void remove() : setConfirmationId(companion.id)}><IconTrashOutline16 size={16} />{operation === 'remove' ? '正在删除…' : removed ? '已删除' : confirming ? '确认删除' : '删除'}</button></div>
    </div>
  </form>
}
