import { SettingsSections } from './settings-sections.js'
import { useState, type ReactNode } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { emptyCharacterCard, normalizeCharacterCard, renderCharacterCore, type CharacterCard } from '../character/domain.js'
import { FormField as Field } from './partner-components.js'
import { WorkspaceDialog, DiscardChangesDialog, errorMessage } from './workspace-components.js'
import Stepper, { Step } from './character-stepper.js'
import { CharacterMemoryEditor } from './character-memory-editor.js'

const SAMPLE: CharacterCard = {
  ...emptyCharacterCard(), enabled: true,
  identity: '一位喜欢观察日常、说话坦率的同行者。对新事物有好奇心，也愿意承认不知道。',
  motivation: '希望一起把事情弄明白。轻松时会开小玩笑，遇到挫折先听清问题；意见不同时讲清理由，不为了讨好而附和。',
  voice: '自然简洁，使用具体的词。不机械称呼，不重复口头禅。需要解释时认真展开，闲聊时保持轻快。',
  relationship: '从互相尊重的熟人开始。亲近程度依据实际交流，不编造共同往事。',
  examples: [
    { user: '今天有点不顺。', assistant: '哪件事最让你挂心？先挑一件说，我们慢慢理。' },
    { user: '你是不是觉得我的想法都对？', assistant: '倒也没有。我喜欢你愿意尝试，但这个做法我有个不同看法，想听听吗？' },
  ],
}

export function CharacterEditor({ companion, card, disabled, onChange }: { companion: CompanionView; card?: CharacterCard; disabled: boolean; onChange(card: CharacterCard): void }): JSX.Element {
  const [wizard, setWizard] = useState(false)
  const [section, setSection] = useState<'core' | 'voice' | 'world' | 'trial' | 'memory'>('core')
  const hasContent = Boolean(card && (card.identity || card.motivation || card.voice || card.relationship || card.greeting || card.examples.length || card.lore.length))
  return <section className="dsh-partner-character" aria-label="人格强化">
    <header><div><span className="dsh-partner-character-kicker">CHARACTER</span><h3>人格强化 <small>可选</small></h3><p>让身份有自己的行为逻辑、说话方式和持续的关系记忆。</p></div>
      <button type="button" role="switch" aria-label="启用人格强化" aria-checked={card?.enabled === true} className="dsh-partner-switch" data-on={card?.enabled === true} disabled={disabled} onClick={() => { if (!hasContent) setWizard(true); else onChange({ ...card!, enabled: !card!.enabled }) }}><i /></button>
    </header>
    {!hasContent ? <div className="dsh-partner-character-empty"><strong>给这个身份多一点个性</strong><p>四步建立人格卡。未启用时，伙伴继续使用基本身份与行为准则。</p><button type="button" disabled={disabled} onClick={() => setWizard(true)}>创建人格卡</button></div> : <>
      <p className="dsh-partner-character-status">{card!.enabled ? '启用后，每轮对话都会应用人格卡；世界设定按话题加载。保存身份后生效。' : '强化已关闭，卡片内容保留。伙伴继续使用原身份。'}</p>
      <SettingsSections<typeof section> label="人格内容分段" value={section} onChange={setSection} sections={[
        {id: 'core', title: '角色核心', content: <fieldset disabled={disabled} className="dsh-partner-character-fields"><CharacterFields card={card!} onChange={onChange} section="core" /></fieldset>},
        {id: 'voice', title: '说话方式', detail: `${card!.examples.length} 组示例`, content: <fieldset disabled={disabled} className="dsh-partner-character-fields"><CharacterFields card={card!} onChange={onChange} section="voice" /></fieldset>},
        {id: 'world', title: '世界与关系', detail: `${card!.lore.length} 条设定`, content: <fieldset disabled={disabled} className="dsh-partner-character-fields"><CharacterFields card={card!} onChange={onChange} section="world" /></fieldset>},
        {id: 'trial', title: '预览试聊', content: <CharacterTrial companion={companion} card={card!} />},
        {id: 'memory', title: '角色记忆', content: <CharacterMemoryEditor companionId={companion.id} />},
      ]} />
    </>}
    {wizard && <CharacterWizard companion={companion} initial={card ?? emptyCharacterCard()} close={() => setWizard(false)} complete={value => { onChange(value); setWizard(false) }} />}
  </section>
}

function CharacterWizard({ companion, initial, close, complete }: { companion: CompanionView; initial: CharacterCard; close(): void; complete(card: CharacterCard): void }): JSX.Element {
  const [draft, setDraft] = useState(() => ({ ...structuredClone(initial), enabled: true }))
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string>()
  const [discard, setDiscard] = useState(false)
  const next = () => {
    setError(undefined)
    if (step === 1 && (!draft.identity.trim() || !draft.motivation.trim())) { setError('请写下角色核心和行为动机'); return }
    if (step === 2 && (!draft.voice.trim() || draft.examples.filter(x => x.user.trim() && x.assistant.trim()).length < 2)) { setError('请补充语言风格和至少两组完整对话示例'); return }
    try { if (step >= 3) normalizeCharacterCard(draft); if (step === 4) complete(draft); else setStep(step + 1) }
    catch (e) { setError(errorMessage(e)) }
  }
  const dismiss = () => JSON.stringify(draft) !== JSON.stringify({ ...initial, enabled: true }) ? setDiscard(true) : close()
  return <><WorkspaceDialog title="创建人格卡" eyebrow="CHARACTER SETUP" detail="从具体行为开始，再用对话示例让语气变得鲜明。完成后仍可直接编辑。" close={dismiss} width="wide" className="dsh-partner-character-dialog">
    {error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <Stepper step={step} onStepChange={n => { setStep(n); setError(undefined) }} onNext={next} busy={false} backButtonText="上一步" nextButtonText="继续" completeButtonText="应用到身份草稿">
      <Step title="角色核心"><p className="dsh-partner-character-hint">写清他是谁，以及他为什么这样做。也可以先载入通用示例，再改成你的角色。</p><button type="button" onClick={() => setDraft(structuredClone(SAMPLE))}>填入通用示例</button><CharacterFields card={draft} onChange={setDraft} section="core" /></Step>
      <Step title="表达示例"><CharacterFields card={draft} onChange={setDraft} section="voice" /></Step>
      <Step title="世界关系"><CharacterFields card={draft} onChange={setDraft} section="world" /></Step>
      <Step title="预览试聊"><p>完成后请点击身份页面的“保存身份”。试聊独立进行，不写入正式记忆。</p><CharacterTrial companion={companion} card={draft} /></Step>
    </Stepper>
  </WorkspaceDialog>{discard && <DiscardChangesDialog keepEditing={() => setDiscard(false)} discard={close} />}</>
}

function CharacterFields({ card, onChange, section }: { card: CharacterCard; onChange(card: CharacterCard): void; section: 'core' | 'voice' | 'world' }): JSX.Element {
  const field = (key: 'identity' | 'motivation' | 'voice' | 'relationship' | 'greeting', label: string, hint: string, max: number, rows = 3) => <Field label={label} hint={hint}><textarea rows={rows} maxLength={max} value={card[key]} onChange={e => onChange({ ...card, [key]: e.target.value })} /></Field>
  if (section === 'core') return <div className="dsh-partner-character-section"><h4>角色核心</h4>{field('identity', '身份与背景', '最重要的身份、经历和个性，不必写完整传记。', 2000)}{field('motivation', '行为与情绪逻辑', '平时、受挫、被关心或意见不同时，会如何回应？为什么？', 3000, 4)}</div>
  if (section === 'voice') return <div className="dsh-partner-character-section"><h4>说话方式</h4>{field('voice', '语言风格', '措辞、幽默、称呼与不喜欢的表达方式。', 1500)}
    <div className="dsh-partner-fields two"><Field label="回复节奏"><select value={card.length} onChange={e => onChange({ ...card, length: e.target.value as CharacterCard['length'] })}><option value="short">简短闲聊</option><option value="balanced">自然适中</option><option value="rich">丰富叙述</option></select></Field><label className="dsh-partner-character-check"><input type="checkbox" checked={card.narration} onChange={e => onChange({ ...card, narration: e.target.checked })} />允许少量动作描写</label></div>
    <h4>对话示例 <small>至少两组，展示不同情境</small></h4>
    {card.examples.map((item, index) => <ContentDisclosure className="dsh-partner-character-example" key={index} initialOpen={!item.user && !item.assistant}><summary>示例 {index + 1}<small>{item.user || '待填写'}</small></summary><Field label="对方说"><textarea rows={2} maxLength={1000} value={item.user} onChange={e => onChange({ ...card, examples: card.examples.map((x, i) => i === index ? { ...x, user: e.target.value } : x) })} /></Field><Field label="角色回应"><textarea rows={3} maxLength={1500} value={item.assistant} onChange={e => onChange({ ...card, examples: card.examples.map((x, i) => i === index ? { ...x, assistant: e.target.value } : x) })} /></Field><Field label="避免的回复（可选）" hint="写一条不符合这个角色的回复，帮助区分语气。"><textarea rows={2} maxLength={1500} value={item.avoid ?? ''} onChange={e => onChange({ ...card, examples: card.examples.map((x, i) => i === index ? { ...x, avoid: e.target.value } : x) })} /></Field><button type="button" onClick={() => onChange({ ...card, examples: card.examples.filter((_, i) => i !== index) })} aria-label={`移除示例 ${index + 1}`}>移除</button></ContentDisclosure>)}
    <button type="button" disabled={card.examples.length >= 8} onClick={() => onChange({ ...card, examples: [...card.examples, { user: '', assistant: '' }] })}>添加对话示例</button>
  </div>
  return <div className="dsh-partner-character-section"><h4>世界与关系</h4>{field('relationship', '关系起点', '初次交流时如何相处，不会覆盖已经保存的真实交流。', 1000)}{field('greeting', '开场白参考', '可选，只用于首次见面的语气，不会每轮重复。', 1000)}
    <h4>世界设定 <small>可选 · 提到关键词时加载</small></h4><p className="dsh-partner-character-hint">核心身份始终保留。地点、人物、物品等细节放在这里，每轮最多加载 5 条。</p>
    {card.lore.map((entry, index) => <ContentDisclosure className="dsh-partner-character-lore" key={entry.id} initialOpen={!entry.title && !entry.content}><summary>{entry.title || `新条目 ${index + 1}`}<small>{entry.enabled ? '已启用' : '已停用'}</small></summary>
      <Field label="条目标题"><input maxLength={100} value={entry.title} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, title: e.target.value } : x) })} /></Field>
      <Field label="触发词" hint="最多 8 个，用逗号分隔。"><input value={entry.keywords.join('，')} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, keywords: e.target.value.split(/[,，]/).map(t => t.trim()) } : x) })} /></Field>
      <Field label="设定内容"><textarea rows={3} maxLength={2000} value={entry.content} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, content: e.target.value } : x) })} /></Field>
      <div className="dsh-partner-character-row"><label><input type="checkbox" checked={entry.enabled} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, enabled: e.target.checked } : x) })} />启用条目</label><button type="button" onClick={() => onChange({ ...card, lore: card.lore.filter((_, i) => i !== index) })}>移除条目</button></div>
    </ContentDisclosure>)}<button type="button" disabled={card.lore.length >= 40} onClick={() => onChange({ ...card, lore: [...card.lore, { id: crypto.randomUUID(), title: '', keywords: [], content: '', enabled: true }] })}>添加世界条目</button>
  </div>
}

function CharacterTrial({ companion, card }: { companion: CompanionView; card: CharacterCard }): JSX.Element {
  const [message, setMessage] = useState('今天不太顺利，想和你聊聊。')
  const [history, setHistory] = useState<Array<{user: string; assistant: string}>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async () => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { normalizeCharacterCard(card); const result = await api<{reply:string}>(`/companions/${encodeURIComponent(companion.id)}/character/preview`, {method:'POST', body:JSON.stringify({card,message,history})}); setHistory(old => [...old, {user:message,assistant:result.reply}].slice(-8)); setMessage('') }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="dsh-partner-character-trial"><details><summary>查看人格规则</summary><pre>{renderCharacterCore(card) || '人格强化未启用。'}</pre></details><p className="dsh-partner-character-hint">使用此伙伴当前模型，最多保留 8 组试聊，不调用工具、不写正式记忆。</p>
    <div aria-live="polite">{history.map((x, i) => <div className="dsh-partner-trial-exchange" key={i}><p><b>你</b>{x.user}</p><p><b>{companion.name}</b>{x.assistant}</p></div>)}</div>
    <Field label="试聊消息"><textarea rows={2} maxLength={2000} disabled={busy} value={message} onChange={e => setMessage(e.target.value)} /></Field>{error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <div className="dsh-partner-character-row"><button type="button" disabled={busy} onClick={() => setHistory([])}>重新试聊</button><button type="button" disabled={busy || !message.trim() || !card.enabled} onClick={() => void send()}>{busy ? '角色正在回复…' : '发送试聊'}</button></div>
  </div>
}

function ContentDisclosure({children, className, initialOpen}: {children: ReactNode; className: string; initialOpen: boolean}): JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  return <details className={className} open={open} onToggle={event => setOpen(event.currentTarget.open)}>{children}</details>
}
