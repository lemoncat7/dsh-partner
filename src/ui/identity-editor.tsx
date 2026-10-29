import { SleepEditor } from './sleep-editor.js'
import { sleepPolicy } from '../character/sleep.js'
import { IdleContactEditor } from './idle-contact-editor.js'
import { SettingsSections } from './settings-sections.js'
import { CharacterEditor } from './character-editor.js'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IconCheckOutlineRegular as IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView } from '../client-api.js'
import { pageIdentity, effectiveIdentity } from '../companions/identity.js'
import { roleTextForCard } from '../character/domain.js'
import { DEFAULT_IDLE_CONTACT } from '../character/idle-contact.js'
import { FormField as Field, SectionHeading as Section } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

interface Props {
  companion: CompanionView
  onChanged(): Promise<void>
}

/** Identity-scoped lifetime prevents confirmations and late results crossing targets. */
export function IdentityEditor(props: Props): JSX.Element { return <IdentityEditorForm key={props.companion.id} {...props} /> }

function IdentityEditorForm({ companion, onChanged }: Props): JSX.Element {
  const [form, setForm] = useState(() => pageIdentity(companion))
  const revision = useRef(companion.updatedAt)
  const [operation, setOperation] = useState<'save'>()
  const [section, setSection] = useState<'identity' | 'character' | 'idle' | 'sleep'>('identity')
  const dirty = useRef(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!dirty.current) { setForm(pageIdentity(companion)); revision.current = companion.updatedAt } }, [companion.updatedAt])
  const busy = operation !== undefined
  const edit = (value: typeof form) => { setForm(value); dirty.current = true; setSaved(false) }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked.current) return
    locked.current = true; setOperation('save'); setError(undefined)
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(companion.id)}/identity`, { method: 'PUT', body: JSON.stringify({ expectedAt: revision.current, identity: { ...form, characterCard: form.characterCard ?? null, idleContact: form.idleContact ?? null, sleepPolicy: form.sleepPolicy ?? null } }) })
      committed = true
      dirty.current = false
      await onChanged()
      if (alive.current) setSaved(true)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '身份已保存，但刷新失败，无需重复保存：' : '保存失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setOperation(undefined) }
  }
  return <form onInvalidCapture={event => { event.preventDefault(); const target = event.target as HTMLElement; const idle = Boolean(target.closest('[aria-label="闲时主动联系"]')); setSection(idle ? 'idle' : 'identity'); setError(idle ? '请选择闲时联系的目标会话。' : '请填写基本身份中的名字和角色。'); requestAnimationFrame(() => target.focus()) }} id="dsh-partner-identity-editor" className="dsh-partner-form is-identity" aria-busy={operation !== undefined} onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="身份与角色" detail="这里编辑的是你保留的原稿。保存会同时更新草稿和生效身份；聊天中让 AI 生成人格或调整设定，只会改变生效内容。" />
    <details className="dsh-partner-settings-advanced dsh-partner-effective-identity">
      <summary>查看当前生效身份 <small>{JSON.stringify(pageIdentity(companion)) === JSON.stringify(effectiveIdentity(companion)) ? '与已保存草稿一致' : '已与草稿不同'}</small></summary>
      <p className="dsh-partner-character-hint">可以直接对伙伴说：“根据我的要求生成并应用人格卡……”；AI 保存后的内容在这里查看，下一轮生效。下方表单仍保留你的草稿。</p>
      <EffectiveIdentity companion={companion} />
      <button type="button" disabled={busy} onClick={() => { revision.current = companion.updatedAt; edit(effectiveIdentity(companion)) }}>将生效内容复制到编辑区</button>
      <p className="dsh-partner-character-hint">复制后仍需保存，才会替换原稿。</p>
    </details>
    <section className="dsh-partner-identity-card" aria-label="身份配置">
    <SettingsSections<typeof section> label="身份设置分段" value={section} onChange={setSection} sections={[{id: 'identity', title: '基本身份', detail: '名字、定位与行为准则', content: <>
    <div className="dsh-partner-fields two"><Field label="名字"><input disabled={busy} required maxLength={60} value={form.name} onChange={event => edit({ ...form, name: event.target.value })} /></Field><Field label="角色"><input disabled={busy} required maxLength={120} value={form.role} onChange={event => edit({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea disabled={busy} rows={2} maxLength={500} value={form.description} onChange={event => edit({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="建议写职责、表达方式与边界；渠道、工具和授权由系统单独控制。"><textarea disabled={busy} rows={9} maxLength={12000} value={form.instructions} onChange={event => edit({ ...form, instructions: event.target.value })} /></Field>
    </>}, {id: 'character', title: '角色聊天', detail: form.characterCard?.enabled ? '已启用 · 设定与试聊' : '可选 · 设定与试聊', content: <CharacterEditor companion={companion} {...(form.characterCard ? {card:form.characterCard} : {})} disabled={busy} onChange={characterCard => edit({...form,characterCard})} />}, {id: 'idle', title: '闲时主动联系', detail: form.idleContact?.enabled ? '已开启 · 空闲时来聊聊' : '可选 · 不打扰地联系', content: <IdleContactEditor companionId={companion.id} value={form.idleContact} disabled={busy} onChange={idleContact => edit({...form,idleContact})} />}, {id: 'sleep', title: '睡眠与做梦', detail: '自主休息 · 梦境与感受', content: <SleepEditor companion={companion} value={sleepPolicy(form)} disabled={busy} active={section === 'sleep'} onChange={sleepPolicy => edit({...form,sleepPolicy})} />}]} />
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    <div className="dsh-partner-form-actions"><button type="button" disabled={busy} onClick={() => { setForm(pageIdentity(companion)); revision.current = companion.updatedAt; dirty.current = false; setError(undefined); setSaved(false) }}>重新载入已保存草稿</button><span role="status">{saved && <><IconCheckOutline14 size={14} />草稿已保存并应用，下一轮将使用新身份</>}</span><button disabled={busy}>{operation === 'save' ? '正在保存…' : '保存身份'}</button></div>
    </section>
  </form>
}

function EffectiveIdentity({ companion }: { companion: CompanionView }): JSX.Element {
  const card = companion.characterCard, idle = companion.idleContact ?? DEFAULT_IDLE_CONTACT
  return <div className="dsh-partner-effective-content">
    <h4>{companion.name} · {companion.role}</h4>
    {companion.description && <p>{companion.description}</p>}
    <h4>长期行为准则</h4><p>{companion.instructions || '未填写'}</p>
    <h4>角色聊天 · {card?.enabled ? '已开启' : '已关闭'}</h4>
    {card && <><p>{roleTextForCard(card) || '尚未编写人格卡'}</p><h4>聊天方式</h4><p>{card.chatStyle || '未额外指定'}<br />回复长度：{{short:'简短',balanced:'适中',rich:'丰富'}[card.length]} · 旁白：{card.narration ? '开启' : '关闭'} · 分段：{card.segmentedReplies ? '开启' : '关闭'} · 表情：{card.stickersEnabled ? '开启' : '关闭'}</p>
    {card.lore.map(item => <div key={item.id}><h4>{item.title || '背景资料'} · {item.enabled ? '启用' : '停用'}</h4><p>关键词：{item.keywords.join('、')}<br />{item.content}</p></div>)}</>}
    <h4>闲时主动联系 · {idle.enabled ? '已开启' : '已关闭'}</h4><p>空闲 {idle.idleMinutes} 分钟后联系，不限制每天次数。</p>
    <h4>自主睡眠 · {sleepPolicy(companion).enabled ? '已开启' : '已关闭'}</h4><p>做梦：{sleepPolicy(companion).dreamsEnabled ? '允许' : '关闭'}，不设固定时段。</p>
  </div>
}
