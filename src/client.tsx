import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { activatePluginWorkspace, observePluginWorkspace } from '@lemoncat7/dsh-plugin-ui'
import {
  IconAgentPresetOutline16, IconCheckOutline14, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconDataOutline16, IconEditOutline16, IconLinkOutline16, IconPlusOutline16,
  IconRefreshOutline16, IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'
import cssText from './client.css'
import { api, loadPartner, type AutomationView, type Capability, type ChannelView, type CompanionView, type DailyReflectionView, type LoginView, type MemoryGraphView, type MemoryRelationView, type MemoryView, type ModelCatalogView, type PartnerSnapshot } from './client-api.js'
import { useWorkspaceTopAnchor } from './sidebar-anchor.js'

const PLUGIN_ID = '@lemoncat7/dsh-partner'
const STYLE_ID = `${PLUGIN_ID}/client`
type SidebarProps = PropsRuntime<'sidebar.footer.action'>
type ConversationProps = PropsRuntime<'conversation'>
type Tab = 'home' | 'identity' | 'capabilities' | 'weixin' | 'memory'

interface Controller {
  open(companionId?: string): void
  close(): void
  toggle(): void
  isOpen(): boolean
  selected(): string | undefined
  openSession(routeId: string, sessionId: string): Promise<void>
  renewSession(routeId: string): Promise<void>
  subscribe(listener: () => void): () => void
}

export const inject = ['slots', 'layout', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'dsh-partner: styles')
  const controller = createController(ctx)
  ctx.effect(() => observePluginWorkspace(PLUGIN_ID, controller.close), 'dsh-partner: exclusive workspace')
  ctx.effect(() => () => controller.close(), 'dsh-partner: workspace lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'partner', order: -120,
  }, props => <PartnerSidebar {...props} controller={controller} collapse={() => ctx.layout.toggleSidebar()} />))
}

function createController(ctx: ClientContext): Controller {
  const listeners = new Set<() => void>()
  let selected: string | undefined
  let dispose: (() => void) | undefined
  const notify = (): void => { for (const listener of listeners) listener() }
  const controller: Controller = {
    open(companionId) {
      if (companionId !== undefined) selected = companionId
      if (dispose === undefined) {
        activatePluginWorkspace(PLUGIN_ID)
        dispose = ctx.slots.register({ name: 'conversation', priority: -3 }, props => <PartnerWorkspace {...props} controller={controller} />)
      }
      notify()
    },
    close() { const current = dispose; dispose = undefined; current?.(); notify() },
    toggle() { if (dispose === undefined) controller.open(); else controller.close() },
    isOpen: () => dispose !== undefined,
    selected: () => selected,
    async openSession(routeId, sessionId) {
      const prepared = await api<{ sessionId: string }>(`/sessions/${encodeURIComponent(routeId)}/prepare`, { method: 'POST' })
      if (prepared.sessionId !== sessionId) throw new Error('伙伴会话标识不一致')
      await waitForClientSession(ctx, sessionId)
      controller.close()
      clientSessions(ctx).open(sessionId as SessionId)
    },
    async renewSession(routeId) {
      const renewed = await api<{ routeId: string; sessionId: string }>(`/sessions/${encodeURIComponent(routeId)}/renew`, { method: 'POST' })
      await waitForClientSession(ctx, renewed.sessionId)
      controller.close()
      clientSessions(ctx).open(renewed.sessionId as SessionId)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  return controller
}

function PartnerSidebar(props: SidebarProps & { controller: Controller; collapse(): void }): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  useWorkspaceTopAnchor(ref)
  const [open, setOpen] = useState(true)
  const [snapshot, setSnapshot] = useState<PartnerSnapshot>()
  const [, update] = useState(0)
  useEffect(() => props.controller.subscribe(() => update(value => value + 1)), [props.controller])
  useEffect(() => { void loadPartner().then(setSnapshot).catch(() => {}) }, [props.controller.isOpen()])
  const launch = (id?: string): void => {
    props.controller.open(id)
    if (props.wide && window.matchMedia('(max-width: 820px)').matches) props.collapse()
  }
  if (!props.wide) return <section ref={ref} className="dsh-partner-sidebar is-rail"><button type="button" className={`dsh-partner-rail${props.controller.isOpen() ? ' is-active' : ''}`} title="伙伴" onClick={() => props.controller.toggle()}><IconAgentPresetOutline16 size={18} /></button></section>
  return <section ref={ref} className="dsh-partner-sidebar">
    <div className="dsh-partner-sidebar-heading">
      <button type="button" className="dsh-partner-sidebar-title" aria-expanded={open} onClick={() => setOpen(value => !value)}><span data-open={open}><IconChevronDownOutline14 size={14} /></span>伙伴</button>
      <button type="button" className="dsh-partner-sidebar-open" onClick={() => launch()} aria-label="打开伙伴面板"><IconPlusOutline16 size={16} /></button>
    </div>
    {open && <div className="dsh-partner-sidebar-list">
      <button type="button" className={`dsh-partner-sidebar-row${props.controller.isOpen() ? ' is-active' : ''}`} onClick={() => launch()}>
        <span className="dsh-partner-sidebar-symbol"><IconAgentPresetOutline16 size={16} /></span><span><strong>伙伴面板</strong><small>{snapshot ? `${snapshot.companions.length} 位伙伴 · ${snapshot.channels.filter(item => item.runtimeStatus === 'running').length} 个微信在线` : '身份、能力与渠道'}</small></span><i className={snapshot?.channels.some(item => item.runtimeStatus === 'running') ? 'is-online' : ''} />
      </button>
    </div>}
  </section>
}

function PartnerWorkspace({ controller }: ConversationProps & { controller: Controller }): JSX.Element {
  const [snapshot, setSnapshot] = useState<PartnerSnapshot>()
  const [selectedId, setSelectedId] = useState(controller.selected())
  const [tab, setTab] = useState<Tab>('home')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try {
      const next = await loadPartner()
      setSnapshot(next)
      setSelectedId(current => next.companions.some(item => item.id === current) ? current : next.companions[0]?.id)
      setError(undefined)
    } catch (reason) { setError(message(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => controller.subscribe(() => { const next = controller.selected(); if (next) setSelectedId(next) }), [controller])
  const selected = snapshot?.companions.find(item => item.id === selectedId)
  const create = async (): Promise<void> => {
    try {
      const companion = await api<CompanionView>('/companions', { method: 'POST', body: JSON.stringify({ companion: {
        name: '新伙伴', role: '长期 AI 工作伙伴', description: '', instructions: '', capabilities: ['knowledge', 'skills'],
      } }) })
      await refresh(); setSelectedId(companion.id); setTab('identity')
    } catch (reason) { setError(message(reason)) }
  }
  const openSession = async (routeId: string, sessionId: string): Promise<void> => {
    try { setError(undefined); await controller.openSession(routeId, sessionId) }
    catch (reason) { setError(message(reason)) }
  }
  const renewSession = async (routeId: string): Promise<void> => {
    try { setError(undefined); await controller.renewSession(routeId) }
    catch (reason) { setError(message(reason)) }
  }
  return <main className="dsh-partner-workspace" data-xiaohei-surface="plugin-workspace">
    <header className="dsh-partner-topbar"><div><button type="button" data-xiaohei-workspace-close onClick={controller.close} aria-label="返回会话" title="返回会话"><IconChevronLeftOutline14 size={15} /></button><IconAgentPresetOutline16 size={18} /><span><strong>伙伴</strong><small>长期身份与微信渠道</small></span></div></header>
    <div className="dsh-partner-grid">
      <aside className="dsh-partner-roster">
        <div className="dsh-partner-roster-title"><span><small>COMPANIONS</small><strong>伙伴名册</strong></span><button type="button" onClick={() => { void create() }} aria-label="新建伙伴"><IconPlusOutline16 size={16} /></button></div>
        <div className="dsh-partner-roster-list">{snapshot?.companions.map(companion => {
          const channel = snapshot.channels.find(item => item.companionId === companion.id)
          return <button type="button" key={companion.id} className={selectedId === companion.id ? 'is-active' : ''} onClick={() => { setSelectedId(companion.id); setTab('home') }}>
            <Avatar name={companion.name} /><span><strong>{companion.name}</strong><small>{companion.role}</small></span><i className={channel?.runtimeStatus === 'running' ? 'is-online' : ''} title={channel ? channel.runtimeStatus : '未连接渠道'} />
          </button>
        })}</div>
        <div className="dsh-partner-roster-note"><IconLinkOutline16 size={16} /><span><strong>身份与渠道分离</strong><small>微信只负责收发，权限仍由 DSH 工具决定。</small></span></div>
      </aside>
      <section className="dsh-partner-stage">
        {loading ? <State title="正在读取伙伴…" /> : selected === undefined ? <State title="创建第一个伙伴" detail="伙伴会保存独立身份、能力和微信会话。" action={<button onClick={() => { void create() }}>新建伙伴</button>} /> : <>
          <div className="dsh-partner-identity"><Avatar name={selected.name} /><span><small>ACTIVE COMPANION</small><h1>{selected.name}</h1><p>{selected.description || selected.role}</p></span><Status channel={snapshot?.channels.find(item => item.companionId === selected.id)} /></div>
          <nav className="dsh-partner-tabs" aria-label="伙伴配置">
            <TabButton active={tab === 'home'} onClick={() => setTab('home')} icon={<IconAgentPresetOutline16 size={16} />}>总览</TabButton>
            <TabButton active={tab === 'identity'} onClick={() => setTab('identity')} icon={<IconEditOutline16 size={16} />}>身份</TabButton>
            <TabButton active={tab === 'capabilities'} onClick={() => setTab('capabilities')} icon={<IconAgentPresetOutline16 size={16} />}>能力</TabButton>
            <TabButton active={tab === 'weixin'} onClick={() => setTab('weixin')} icon={<WeixinGlyph />}>微信</TabButton>
            <TabButton active={tab === 'memory'} onClick={() => setTab('memory')} icon={<IconDataOutline16 size={16} />}>记忆</TabButton>
          </nav>
          <div className="dsh-partner-stage-scroll">
            {tab === 'home' && <HomePanel companion={selected} snapshot={snapshot!} navigate={setTab} openSession={openSession} renewSession={renewSession} />}
            {tab === 'identity' && <IdentityEditor companion={selected} count={snapshot?.companions.length ?? 1} onChanged={refresh} />}
            {tab === 'capabilities' && <CapabilityEditor companion={selected} presets={snapshot?.presets ?? []} onChanged={refresh} />}
            {tab === 'weixin' && <WeixinPanel companion={selected} snapshot={snapshot!} onChanged={refresh} />}
            {tab === 'memory' && <MemoryPanel companion={selected} snapshot={snapshot!} openSession={openSession} renewSession={renewSession} onChanged={refresh} />}
          </div>
        </>}
        {error && <p className="dsh-partner-error" role="alert">{error}</p>}
      </section>
    </div>
  </main>
}

function HomePanel({ companion, snapshot, navigate, openSession, renewSession }: { companion: CompanionView; snapshot: PartnerSnapshot; navigate(tab: Tab): void; openSession(routeId: string, sessionId: string): Promise<void>; renewSession(routeId: string): Promise<void> }): JSX.Element {
  const channel = snapshot.channels.find(item => item.companionId === companion.id)
  const sessions = snapshot.sessions.filter(item => item.companionId === companion.id)
  const pending = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'pending').length : 0
  const approved = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'approved').length : 0
  const capabilities = companion.capabilities.map(item => ({ knowledge: '知识库', skills: '技能', ssh: 'SSH', git: 'Git' })[item])
  const online = channel?.runtimeStatus === 'running'
  const latestSession = sessions.reduce<(typeof sessions)[number] | undefined>((latest, item) => latest === undefined || item.lastMessageAt > latest.lastMessageAt ? item : latest, undefined)
  return <div className="dsh-partner-home">
    <header className="dsh-partner-home-heading">
      <span><small>工作台</small><h2>{online ? `${companion.name} 正在微信待命` : `连接 ${companion.name} 的第一条渠道`}</h2></span>
      <p>{online ? '消息、授权与上下文边界都在这里汇总。' : '伙伴身份已经就绪，连接微信后即可开始持续工作。'}</p>
    </header>

    <section className={`dsh-partner-home-channel${online ? ' is-online' : ''}`}>
      <div className="dsh-partner-home-route" aria-hidden="true">
        <Avatar name={companion.name} />
        <span className="dsh-partner-route-line"><i /></span>
        <span className="dsh-partner-route-weixin"><WeixinGlyph large /></span>
      </div>
      <div className="dsh-partner-home-channel-copy">
        <span className="dsh-partner-home-kicker"><i />主要渠道 · 微信</span>
        <h3>{!channel ? '等待扫码连接' : online ? '连接正常，正在接收消息' : channel.runtimeStatus === 'error' ? '渠道连接需要处理' : '渠道当前已停用'}</h3>
        <p>{!channel ? '通过微信 iLink Bot 接入。凭据只进入 DSH 凭据库，联系人首次发消息仍需你的批准。' : online ? '每位联系人拥有独立 DSH 会话，伙伴身份一致，但上下文不会互相混合。' : channel.lastError || '渠道配置仍然保留，可以随时重新启用。'}</p>
        <div className="dsh-partner-home-channel-actions">
          <button type="button" className="is-primary" onClick={() => navigate('weixin')}>{!channel ? '连接微信' : pending > 0 ? `处理 ${pending} 个请求` : '管理渠道'}</button>
          <span>{!channel ? '扫码完成，无需粘贴 Token' : `${approved} 位联系人 · ${sessions.length} 个独立会话`}</span>
        </div>
      </div>
    </section>

    <div className="dsh-partner-home-details">
      <section className="dsh-partner-home-profile">
        <header><span><IconUserOutline16 size={16} /></span><div><small>伙伴底稿</small><strong>{companion.role}</strong></div><button type="button" onClick={() => navigate('identity')}>编辑</button></header>
        <blockquote>{companion.instructions || companion.description || '尚未设置长期行为准则。'}</blockquote>
      </section>
      <section className="dsh-partner-home-runtime">
        <header><span><IconAgentPresetOutline16 size={16} /></span><div><small>运行能力</small><strong>{companion.presetId || 'DSH 默认 Preset'}</strong></div><button type="button" onClick={() => navigate('capabilities')}>调整</button></header>
        <div className="dsh-partner-home-capability-list">{capabilities.length ? capabilities.map(item => <em key={item}>{item}</em>) : <small>尚未声明能力范围</small>}</div>
      </section>
      <section className="dsh-partner-home-continuity">
        <header><span><IconDataOutline16 size={16} /></span><div><small>会话连续性</small><strong>{sessions.length ? `${sessions.length} 个共享会话` : '等待第一条消息'}</strong></div><button type="button" onClick={() => latestSession === undefined ? navigate('memory') : latestSession.archived ? void renewSession(latestSession.id) : void openSession(latestSession.id, latestSession.sessionId)}>{latestSession === undefined ? '查看' : latestSession.archived ? '开始新会话' : '打开会话'}</button></header>
        <p>{sessions.length ? `最近活动于 ${relativeTime(Math.max(...sessions.map(item => item.lastMessageAt)))}` : '微信联系人通过配对后，将在这里建立独立上下文。'}</p>
      </section>
    </div>
  </div>
}

function IdentityEditor({ companion, count, onChanged }: { companion: CompanionView; count: number; onChanged(): Promise<void> }): JSX.Element {
  const [form, setForm] = useState(() => companionDraft(companion))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => { setForm(companionDraft(companion)); setSaved(false) }, [companion.id, companion.updatedAt])
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSaving(true); setError(undefined)
    try { await api(`/companions/${companion.id}`, { method: 'PUT', body: JSON.stringify({ companion: form }) }); setSaved(true); await onChanged() }
    catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }
  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除伙伴「${companion.name}」？此操作要求先移除已绑定渠道。`)) return
    try { await api(`/companions/${companion.id}`, { method: 'DELETE' }); await onChanged() } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-form is-identity" onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="工作身份" detail="它不是一次对话的提示词，而是这个伙伴在桌面和微信中的长期行为基线。" />
    <div className="dsh-partner-fields two"><Field label="名字"><input required maxLength={60} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></Field><Field label="角色"><input required maxLength={120} value={form.role} onChange={event => setForm({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea rows={2} maxLength={500} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="建议写职责、表达方式与边界；渠道、工具和授权由系统单独控制。"><textarea rows={9} maxLength={12000} value={form.instructions} onChange={event => setForm({ ...form, instructions: event.target.value })} /></Field>
    {error && <p className="dsh-partner-inline-error">{error}</p>}
    <div className="dsh-partner-form-actions"><span>{saved && <><IconCheckOutline14 size={14} />已保存，后续微信消息将使用新身份</>}</span><button disabled={saving}>{saving ? '正在保存…' : '保存身份'}</button></div>
    <div className="dsh-partner-identity-danger"><span><strong>删除伙伴</strong><small>必须先移除已绑定微信渠道；不会自动把联系人转交给其他伙伴。</small></span><button type="button" disabled={count <= 1} onClick={() => { void remove() }}><IconTrashOutline16 size={16} />删除</button></div>
  </form>
}

function CapabilityEditor({ companion, presets, onChanged }: { companion: CompanionView; presets: PartnerSnapshot['presets']; onChanged(): Promise<void> }): JSX.Element {
  const [form, setForm] = useState(() => companionDraft(companion))
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogView>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => setForm(companionDraft(companion)), [companion.id, companion.updatedAt])
  useEffect(() => { void api<ModelCatalogView>('/models').then(setModelCatalog).catch(reason => setError(message(reason))) }, [])
  const toggle = (capability: Capability): void => setForm(current => ({ ...current, capabilities: current.capabilities.includes(capability) ? current.capabilities.filter(item => item !== capability) : [...current.capabilities, capability] }))
  const save = async (): Promise<void> => {
    setSaving(true); setError(undefined)
    try { await api(`/companions/${companion.id}`, { method: 'PUT', body: JSON.stringify({ companion: form }) }); await onChanged() }
    catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }
  const choices: { id: Capability; title: string; detail: string }[] = [
    { id: 'knowledge', title: '知识库', detail: '允许伙伴在已挂载范围内检索与回写知识。' },
    { id: 'skills', title: '技能', detail: '使用当前 Agent Preset 提供的技能与工作流程。' },
    { id: 'ssh', title: 'SSH', detail: '通过 SSH 插件授权的主机与命令边界工作。' },
    { id: 'git', title: 'Git', detail: '预留 Git 工具能力，仍需对应插件实际安装。' },
  ]
  const selectedProvider = form.provider || modelCatalog?.defaultSelection.provider || ''
  const modelOptions = modelCatalog?.providers.find(item => item.id === selectedProvider)?.models ?? []
  const currentModelMissing = Boolean(form.model) && !modelOptions.some(item => item.id === form.model)
  return <div className="dsh-partner-form is-capabilities"><Section eyebrow="COMPOSITION" title="能力组合" detail="伙伴声明意图范围；真正可调用的工具仍来自所选 Agent Preset，并继续执行各插件权限。" />
    <Field label="Agent Preset" hint="决定这个伙伴实际加载哪些工具、技能和系统提示。"><select value={form.presetId} onChange={event => setForm({ ...form, presetId: event.target.value })}><option value="">跟随 DSH 默认 Preset</option>{presets.filter(item => !item.broken).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
    <div className="dsh-partner-capabilities">{choices.map(choice => <button type="button" key={choice.id} className={form.capabilities.includes(choice.id) ? 'is-active' : ''} onClick={() => toggle(choice.id)}><span>{form.capabilities.includes(choice.id) && <IconCheckOutline14 size={14} />}</span><strong>{choice.title}</strong><small>{choice.detail}</small></button>)}</div>
    <div className="dsh-partner-fields two"><Field label="模型提供方" hint="模型目录来自当前客户端"><select value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value, model: '' })}><option value="">跟随 DSH 默认 · {modelCatalog?.defaultSelection.provider || '正在读取'}</option>{modelCatalog?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></Field><Field label="模型" hint="随提供方联动"><select value={form.model} onChange={event => setForm({ ...form, model: event.target.value })}><option value="">跟随 DSH 默认 · {modelCatalog?.defaultSelection.model || '正在读取'}</option>{currentModelMissing && <option value={form.model}>当前配置 · {form.model}</option>}{modelOptions.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></Field></div>
    {error && <p className="dsh-partner-inline-error">{error}</p>}<div className="dsh-partner-form-actions"><span /><button type="button" disabled={saving} onClick={() => { void save() }}>{saving ? '正在应用…' : '应用能力组合'}</button></div>
  </div>
}

function WeixinPanel({ companion, snapshot, onChanged }: { companion: CompanionView; snapshot: PartnerSnapshot; onChanged(): Promise<void> }): JSX.Element {
  const channel = snapshot.channels.find(item => item.companionId === companion.id)
  const [login, setLogin] = useState<LoginView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!login || login.phase === 'confirmed' || login.phase === 'expired' || login.phase === 'error') return
    const timer = window.setInterval(() => {
      void api<{ login: LoginView; channel?: ChannelView }>(`/weixin/login/${login.id}`).then(async result => {
        setLogin(result.login)
        if (result.channel) { setLogin(undefined); await onChanged() }
      }).catch(reason => setError(message(reason)))
    }, 2_000)
    return () => clearInterval(timer)
  }, [login?.id, login?.phase, onChanged])
  const begin = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try { setLogin(await api('/weixin/login', { method: 'POST', body: JSON.stringify({ companionId: companion.id }) })) }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const toggle = async (): Promise<void> => {
    if (!channel) return
    setBusy(true); setError(undefined)
    try { await api(`/channels/${channel.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: !channel.enabled }) }); await onChanged() }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const pairings = channel ? snapshot.pairings.filter(item => item.channelId === channel.id) : []
  const actPairing = async (id: string, status: 'approved' | 'blocked'): Promise<void> => {
    try { await api(`/pairings/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); await onChanged() } catch (reason) { setError(message(reason)) }
  }
  return <div className="dsh-partner-form is-channel"><Section eyebrow="PRIMARY CHANNEL" title="微信渠道" detail="使用微信 iLink Bot 扫码接入。每个机器人只绑定一个伙伴，每位联系人保持独立 DSH 会话。" />
    {!channel && !login && <div className="dsh-partner-weixin-connect"><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><strong>把 {companion.name} 带到微信</strong><p>扫码后，机器人凭据直接保存进 DSH 凭据库，不会显示在浏览器或普通配置文件中。</p><ul><li>私聊首次联系必须审批</li><li>联系人之间上下文完全隔离</li><li>工具权限不会因微信身份自动扩大</li></ul></span><button type="button" disabled={busy} onClick={() => { void begin() }}>{busy ? '正在申请二维码…' : '扫码连接微信'}</button></div>}
    {login && <div className="dsh-partner-qr"><div className="dsh-partner-qr-code">{login.qrContent && <QRCodeSVG value={login.qrContent} size={176} level="M" />}</div><span><small>WECHAT ILINK BOT</small><strong>{login.phase === 'scanned' ? '已扫码，请在微信确认' : login.phase === 'expired' ? '二维码已过期' : login.phase === 'error' ? '连接失败' : '使用微信扫码'}</strong><p>{login.error || (login.phase === 'scanned' ? '确认后会自动启动渠道，不需要复制 Token。' : '二维码约 5 分钟有效。此页面可以安全地保持打开。')}</p>{(login.phase === 'expired' || login.phase === 'error') && <button type="button" onClick={() => { setLogin(undefined); void begin() }}><IconRefreshOutline16 size={16} />重新生成</button>}</span></div>}
    {channel && <>
      <div className="dsh-partner-channel-card"><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><small>WECHAT CHANNEL</small><strong>{channel.name}</strong><p>{channel.accountId}</p></span><Status channel={channel} /><button type="button" className="dsh-partner-switch" data-on={channel.enabled} disabled={busy} aria-label={channel.enabled ? '停用微信渠道' : '启用微信渠道'} onClick={() => { void toggle() }}><i /></button></div>
      {channel.lastError && <p className="dsh-partner-inline-error">{channel.lastError}</p>}
      <div className="dsh-partner-pairing-heading"><span><small>ACCESS</small><strong>私聊配对</strong></span><em>{pairings.filter(item => item.status === 'pending').length} 个待处理</em></div>
      <div className="dsh-partner-pairings">{pairings.length === 0 ? <State title="还没有联系人" detail="有人首次向机器人发消息后，配对请求会出现在这里。" compact /> : pairings.map(pairing => <article key={pairing.id}><span className={`is-${pairing.status}`}><IconUserOutline16 size={16} /></span><div><strong>{pairing.displayName}</strong><small>{pairing.status === 'pending' ? '等待审批' : pairing.status === 'approved' ? '已授权独立会话' : '已阻止'} · {new Date(pairing.updatedAt).toLocaleString()}</small></div>{pairing.status === 'pending' && <><button onClick={() => { void actPairing(pairing.id, 'blocked') }}>拒绝</button><button className="is-primary" onClick={() => { void actPairing(pairing.id, 'approved') }}>批准</button></>}{pairing.status === 'approved' && <button onClick={() => { void actPairing(pairing.id, 'blocked') }}>撤销</button>}{pairing.status === 'blocked' && <button onClick={() => { void actPairing(pairing.id, 'approved') }}>重新批准</button>}</article>)}</div>
    </>}
    {error && <p className="dsh-partner-inline-error">{error}</p>}
  </div>
}

function MemoryPanel({ companion, snapshot, openSession, renewSession, onChanged }: { companion: CompanionView; snapshot: PartnerSnapshot; openSession(routeId: string, sessionId: string): Promise<void>; renewSession(routeId: string): Promise<void>; onChanged(): Promise<void> }): JSX.Element {
  const sessions = snapshot.sessions.filter(item => item.companionId === companion.id)
  const heartbeat = snapshot.heartbeatStates.find(item => item.companionId === companion.id)
  const [automation, setAutomation] = useState<AutomationView>(() => structuredClone(companion.automation))
  const [memories, setMemories] = useState<MemoryView[]>([])
  const [reflections, setReflections] = useState<DailyReflectionView[]>([])
  const [graph, setGraph] = useState<MemoryGraphView>({ memories: [], relations: [] })
  const [editing, setEditing] = useState<MemoryView>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogView>()
  const loadMemory = useCallback(async () => {
    const [result, relations] = await Promise.all([api<{ memories: MemoryView[]; reflections: DailyReflectionView[] }>(`/companions/${companion.id}/memory`), api<MemoryGraphView>(`/companions/${companion.id}/memory/graph`)])
    setMemories(result.memories); setReflections(result.reflections); setGraph(relations)
  }, [companion.id])
  useEffect(() => { setAutomation(structuredClone(companion.automation)); void loadMemory().catch(reason => setError(message(reason))) }, [companion.id, companion.updatedAt, loadMemory])
  useEffect(() => { void api<ModelCatalogView>('/models').then(setModelCatalog).catch(reason => setError(message(reason))) }, [])
  const inheritedProvider = companion.provider || modelCatalog?.defaultSelection.provider || ''
  const selectedProvider = automation.memory.provider || inheritedProvider
  const modelOptions = modelCatalog?.providers.find(item => item.id === selectedProvider)?.models ?? []
  const save = async (): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await api(`/companions/${companion.id}/automation`, { method: 'PUT', body: JSON.stringify({ automation }) })
      setNotice('记忆与心跳设置已保存')
      await onChanged()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const trigger = async (): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await api<{ checked: boolean; sent: boolean; reason?: string }>(`/companions/${companion.id}/heartbeat/trigger`, { method: 'POST' })
      setNotice(result.sent ? '心跳已完成并发送微信提醒' : result.reason ?? '心跳检查完成')
      await Promise.all([onChanged(), loadMemory()])
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const review = async (): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await api<{ reviewed: number; failed: number; reason?: string }>(`/companions/${companion.id}/memory/review`, { method: 'POST' })
      setNotice(result.reason ?? `终审完成 ${result.reviewed} 篇${result.failed ? `，失败 ${result.failed} 篇` : ''}`); await loadMemory()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const saveMemory = async (): Promise<void> => {
    if (!editing) return
    setBusy(true); setError(undefined)
    try {
      await api(`/companions/${companion.id}/memory/${editing.id}`, { method: 'PUT', body: JSON.stringify({ subject: editing.subject, content: editing.content }) })
      setEditing(undefined); setNotice('记忆已修正'); await loadMemory()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const deleteMemory = async (item: MemoryView): Promise<void> => {
    if (!window.confirm(`删除记忆「${item.subject}」？`)) return
    setBusy(true); setError(undefined)
    try { await api(`/companions/${companion.id}/memory/${item.id}`, { method: 'DELETE' }); if (editing?.id === item.id) setEditing(undefined); await loadMemory() }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  return <div className="dsh-partner-form is-memory"><Section eyebrow="CONTINUITY" title="会话记忆" detail="这里展示渠道会话边界。知识库仍由知识库插件管理，伙伴不会把不同微信联系人的原始上下文混在一起。" />
    <div className="dsh-partner-metrics"><article><small>渠道会话</small><strong>{sessions.length}</strong><p>每位联系人独立</p></article><article><small>长期记忆</small><strong>{memories.filter(item => item.status === 'active').length}</strong><p>{reflections.length} 篇每日回顾</p></article><article><small>最近心跳</small><strong>{heartbeat?.lastCheckedAt ? relativeTime(heartbeat.lastCheckedAt) : '尚未'}</strong><p>{heartbeat?.lastError ? '上次执行异常' : `今日发送 ${heartbeat?.sentCount ?? 0} 次`}</p></article></div>

    <div className="dsh-partner-automation-grid"><section className="dsh-partner-automation">
      <header><span><strong>学习与长期记忆</strong><small>按联系人归档完整对话，提炼每日回顾和结构化记忆，并在相关话题出现时召回。</small></span><button type="button" className="dsh-partner-switch" data-on={automation.memory.enabled} aria-label="启用伙伴学习" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, enabled: !current.memory.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-memory-model"><Field label="保留期限"><select value={automation.memory.retentionDays} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, retentionDays: Number(event.target.value) } }))}><option value={0}>永久保留</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>1 年</option><option value={1095}>3 年</option></select></Field><Field label="提炼 Provider" hint="默认继承伙伴"><select value={automation.memory.provider ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, provider: event.target.value, model: '' } }))}><option value="">跟随伙伴 · {inheritedProvider || 'DSH 默认'}</option>{modelCatalog?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></Field><Field label="提炼模型" hint="默认继承伙伴"><select value={automation.memory.model ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, model: event.target.value } }))}><option value="">跟随伙伴 · {companion.model || modelCatalog?.defaultSelection.model || 'DSH 默认'}</option>{modelOptions.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></Field></div>
      <div className="dsh-partner-review-policy"><button type="button" className="dsh-partner-switch" data-on={automation.memory.dailyReviewEnabled} aria-label="启用每日终审" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewEnabled: !current.memory.dailyReviewEnabled } }))}><i /></button><span><strong>每日终审</strong><small>次日自动合并重复、纠正偏差并建立记忆关系</small></span><label><select aria-label="每日终审时间" value={automation.memory.dailyReviewHour} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewHour: Number(event.target.value) } }))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label><button type="button" disabled={busy || reflections.length === 0} onClick={() => { void review() }}>立即终审</button></div>
    </section>

    <section className="dsh-partner-automation">
      <header><span><strong>主动巡察</strong><small>周期唤醒后在有限预算内发现并核实多个线索；只有值得告诉你的内容才会发送。</small></span><button type="button" className="dsh-partner-switch" data-on={automation.heartbeat.enabled} aria-label="启用伙伴心跳" onClick={() => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, enabled: !current.heartbeat.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-heartbeat">
        <Field label="检查间隔"><select value={automation.heartbeat.intervalMinutes} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, intervalMinutes: Number(event.target.value) } }))}><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={180}>3 小时</option><option value={360}>6 小时</option><option value={720}>12 小时</option><option value={1440}>24 小时</option></select></Field>
        <Field label="免打扰开始"><input type="number" min={0} max={23} value={automation.heartbeat.quietStartHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietStartHour: Number(event.target.value) } }))} /></Field>
        <Field label="免打扰结束"><input type="number" min={0} max={23} value={automation.heartbeat.quietEndHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietEndHour: Number(event.target.value) } }))} /></Field>
        <Field label="每日上限"><select value={automation.heartbeat.dailyLimit} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, dailyLimit: Number(event.target.value) } }))}><option value={0}>不限</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option><option value={8}>8 次</option></select></Field>
      </div>
      {heartbeat?.lastError && <p className="dsh-partner-inline-error">{heartbeat.lastError}</p>}
      <div className="dsh-partner-automation-actions"><button type="button" disabled={busy || sessions.length === 0} onClick={() => { void trigger() }}>立即检查一次</button><button type="button" className="is-primary" disabled={busy} onClick={() => { void save() }}>{busy ? '正在处理…' : '保存设置'}</button></div>
    </section></div>

    {notice && <p className="dsh-partner-inline-notice"><IconCheckOutline14 size={14} />{notice}</p>}
    {error && <p className="dsh-partner-inline-error">{error}</p>}

    <MemoryLibrary memories={memories} reflections={reflections} graph={graph} editing={editing} busy={busy} setEditing={setEditing} save={() => { void saveMemory() }} remove={item => { void deleteMemory(item) }} />

    <div className="dsh-partner-section-heading"><span><small>SESSIONS</small><strong>共享会话</strong></span></div>
    <div className="dsh-partner-session-list">{sessions.map(item => <article key={item.id} data-archived={item.archived}><span><IconDataOutline16 size={16} /></span><div><strong>微信联系人 · {item.userId.slice(-6)}</strong><small>{item.archived ? '已归档 · 长期记忆保留' : `${item.sessionId} · ${new Date(item.lastMessageAt).toLocaleString()}`}</small></div><button type="button" className={item.archived ? 'is-primary' : undefined} onClick={() => { if (item.archived) void renewSession(item.id); else void openSession(item.id, item.sessionId) }}>{item.archived ? '开始新会话' : '打开会话'}</button></article>)}{sessions.length === 0 && <State title="还没有共享会话" detail="联系人完成配对并发来第一条消息后，伙伴会创建网页与微信共用的会话。" compact />}</div>
  </div>
}

type MemoryLibraryMode = 'memory' | 'reflection' | 'graph'
const MEMORY_KINDS: Array<MemoryView['kind'] | 'all'> = ['all', 'profile', 'preference', 'task', 'event', 'relationship', 'emotion']

function MemoryLibrary({ memories, reflections, graph, editing, busy, setEditing, save, remove }: {
  memories: MemoryView[]; reflections: DailyReflectionView[]; graph: MemoryGraphView; editing: MemoryView | undefined; busy: boolean
  setEditing(value?: MemoryView): void; save(): void; remove(item: MemoryView): void
}): JSX.Element {
  const activeMemories = useMemo(() => memories.filter(item => item.status === 'active'), [memories])
  const [mode, setMode] = useState<MemoryLibraryMode>('memory')
  const [kind, setKind] = useState<MemoryView['kind'] | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>()
  const [selectedDate, setSelectedDate] = useState<string>()
  const normalized = query.trim().toLocaleLowerCase()
  const filteredMemories = useMemo(() => activeMemories.filter(item =>
    (kind === 'all' || item.kind === kind) && (!normalized || `${item.subject} ${item.content}`.toLocaleLowerCase().includes(normalized)),
  ), [activeMemories, kind, normalized])
  const filteredReflections = useMemo(() => reflections.filter(item => !normalized ||
    `${item.date} ${item.summary} ${item.events.join(' ')} ${item.openTasks.join(' ')} ${item.learnings.join(' ')}`.toLocaleLowerCase().includes(normalized),
  ), [reflections, normalized])
  const selectedMemory = filteredMemories.find(item => item.id === selectedMemoryId) ?? filteredMemories[0]
  const selectedReflection = filteredReflections.find(item => item.date === selectedDate) ?? filteredReflections[0]

  return <section className="dsh-partner-memory-library">
    <header className="dsh-partner-library-header"><span><small>MEMORY LIBRARY</small><strong>伙伴记忆库</strong><p>按类型检索长期理解，或按日期回看每天的认识变化。</p></span><nav aria-label="记忆内容"><button type="button" className={mode === 'memory' ? 'is-active' : ''} onClick={() => setMode('memory')}>长期记忆 <b>{activeMemories.length}</b></button><button type="button" className={mode === 'reflection' ? 'is-active' : ''} onClick={() => setMode('reflection')}>每日回顾 <b>{reflections.length}</b></button><button type="button" className={mode === 'graph' ? 'is-active' : ''} onClick={() => setMode('graph')}>关系图谱 <b>{graph.relations.length}</b></button></nav></header>
    <div className="dsh-partner-library-tools"><label><span className="sr-only">搜索记忆</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'memory' ? '搜索主题或记忆内容' : '搜索日期、总结或待办'} /></label>{mode === 'memory' && <div className="dsh-partner-memory-kinds">{MEMORY_KINDS.map(value => <button type="button" key={value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{value === 'all' ? '全部' : memoryKind(value)}</button>)}</div>}</div>
    {mode === 'memory' ? <div className="dsh-partner-library-browser">
      <div className="dsh-partner-library-list" role="list">{filteredMemories.length === 0 ? <State title={activeMemories.length === 0 ? '还没有长期记忆' : '没有匹配的记忆'} detail={activeMemories.length === 0 ? '伙伴完成对话后会自动提炼值得长期保留的信息。' : '换个关键词或类型试试。'} compact /> : filteredMemories.map(item => <button type="button" role="listitem" key={item.id} className={selectedMemory?.id === item.id ? 'is-active' : ''} onClick={() => { setSelectedMemoryId(item.id); setEditing(undefined) }}><span data-kind={item.kind}>{memoryKind(item.kind)}</span><strong>{item.subject}</strong><p>{item.content}</p><small>{relativeTime(item.updatedAt)}</small></button>)}</div>
      <div className="dsh-partner-library-detail">{selectedMemory ? <MemoryCard item={selectedMemory} editing={editing?.id === selectedMemory.id ? editing : undefined} busy={busy} setEditing={setEditing} save={save} remove={() => remove(selectedMemory)} /> : <State title="选择一条记忆" detail="记忆详情会显示在这里。" compact />}</div>
    </div> : mode === 'reflection' ? <div className="dsh-partner-library-browser">
      <div className="dsh-partner-library-list is-diary" role="list">{filteredReflections.length === 0 ? <State title={reflections.length === 0 ? '还没有每日回顾' : '没有匹配的回顾'} detail={reflections.length === 0 ? '每日回顾会在每轮完整对话后持续更新。' : '换个关键词或日期试试。'} compact /> : filteredReflections.map(entry => <button type="button" role="listitem" key={entry.date} className={selectedReflection?.date === entry.date ? 'is-active' : ''} onClick={() => setSelectedDate(entry.date)}><time>{entry.date}</time><strong>{entry.turnCount} 轮交流</strong><p>{entry.summary}</p><small>{entry.openTasks.length} 项待跟进 · {entry.learnings.length} 项理解</small></button>)}</div>
      <div className="dsh-partner-library-detail">{selectedReflection ? <DailyReflectionDetail entry={selectedReflection} /> : <State title="选择一天" detail="当天的总结与待办会显示在这里。" compact />}</div>
    </div> : <MemoryGraph graph={graph} query={normalized} />}
  </section>
}

function MemoryGraph({ graph, query }: { graph: MemoryGraphView; query: string }): JSX.Element {
  const visible = graph.memories.filter(item => !query || `${item.subject} ${item.content}`.toLocaleLowerCase().includes(query))
  const [selectedId, setSelectedId] = useState<string>()
  const selected = visible.find(item => item.id === selectedId) ?? visible[0]
  const related = selected ? graph.relations.filter(item => item.sourceMemoryId === selected.id || item.targetMemoryId === selected.id) : []
  const byId = new Map(graph.memories.map(item => [item.id, item]))
  return <div className="dsh-partner-graph-browser"><div className="dsh-partner-graph-index">{visible.length === 0 ? <State title="还没有关系图谱" detail="完成每日终审后，会把有可靠证据的记忆关系整理到这里。" compact /> : visible.map(item => <button type="button" key={item.id} className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}><span data-kind={item.kind}>{memoryKind(item.kind)}</span><strong>{item.subject}</strong><small>{graph.relations.filter(edge => edge.sourceMemoryId === item.id || edge.targetMemoryId === item.id).length} 条关系</small></button>)}</div><div className="dsh-partner-graph-stage">{selected ? <><header><span data-kind={selected.kind}>{memoryKind(selected.kind)}</span><strong>{selected.subject}</strong><p>{selected.content}</p></header><div className="dsh-partner-graph-links">{related.length === 0 ? <State title="暂无可靠关系" detail="终审不会为了填满图谱而猜测关系。" compact /> : related.map(edge => { const outgoing = edge.sourceMemoryId === selected.id; const target = byId.get(outgoing ? edge.targetMemoryId : edge.sourceMemoryId); return target ? <button type="button" key={edge.id} onClick={() => setSelectedId(target.id)}><i /><span><small>{outgoing ? relationLabel(edge.kind) : `被${relationLabel(edge.kind)}`}</small><strong>{target.subject}</strong><p>{edge.label}</p></span><b>{Math.round(edge.confidence * 100)}%</b></button> : null })}</div></> : null}</div></div>
}

function relationLabel(kind: MemoryRelationView['kind']): string { return ({ supports: '支持', depends_on: '依赖', about: '关于', conflicts_with: '冲突', follows: '后续' })[kind] }

function DailyReflectionDetail({ entry }: { entry: DailyReflectionView }): JSX.Element {
  return <article className="dsh-partner-diary-detail"><header><time>{entry.date}</time><strong>{entry.turnCount} 轮交流后的理解</strong><small>更新于 {new Date(entry.updatedAt).toLocaleString()}</small></header><p>{entry.summary}</p><ReflectionGroup title="待跟进" items={entry.openTasks} /><ReflectionGroup title="当天事件" items={entry.events} /><ReflectionGroup title="新理解" items={entry.learnings} /><ReflectionGroup title="已完成" items={entry.completedTasks} /></article>
}

function ReflectionGroup({ title, items }: { title: string; items: string[] }): JSX.Element | null {
  if (items.length === 0) return null
  return <section><strong>{title}</strong><ul>{items.map(item => <li key={item}>{item}</li>)}</ul></section>
}

function MemoryCard({ item, editing, busy, setEditing, save, remove }: { item: MemoryView; editing: MemoryView | undefined; busy: boolean; setEditing(value?: MemoryView): void; save(): void; remove(): void }): JSX.Element {
  return <article data-kind={item.kind}>{editing ? <div className="dsh-partner-memory-editor">
    <input aria-label="记忆主题" value={editing.subject} onChange={event => setEditing({ ...editing, subject: event.target.value })} />
    <textarea aria-label="记忆内容" value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} />
    <footer><button type="button" onClick={() => setEditing(undefined)}>取消</button><button type="button" className="is-primary" disabled={busy || !editing.subject.trim() || !editing.content.trim()} onClick={save}>保存修正</button></footer>
  </div> : <>
    <header><span>{memoryKind(item.kind)}</span><div><button type="button" onClick={() => setEditing({ ...item })}>编辑</button><button type="button" onClick={remove}>删除</button></div></header>
    <strong>{item.subject}</strong><p>{item.content}</p>
    <footer><progress max={1} value={item.confidence} aria-label={`置信度 ${Math.round(item.confidence * 100)}%`} /><small>{item.locked ? '手动确认' : `${Math.round(item.confidence * 100)}% 可信`} · {relativeTime(item.updatedAt)}</small></footer>
  </>}</article>
}

function Status({ channel }: { channel: ChannelView | undefined }): JSX.Element {
  const status = !channel ? 'unbound' : channel.runtimeStatus
  return <span className={`dsh-partner-status is-${status}`}><i />{!channel ? '未连接' : statusLabel(channel.runtimeStatus)}</span>
}
function statusLabel(status: ChannelView['runtimeStatus']): string { return status === 'running' ? '微信在线' : status === 'starting' ? '连接中' : status === 'error' ? '连接异常' : '已停用' }

function Avatar({ name, small = false }: { name: string; small?: boolean }): JSX.Element { return <span className={`dsh-partner-avatar${small ? ' is-small' : ''}`} aria-hidden="true">{[...name][0] ?? '伴'}</span> }
function WeixinGlyph({ large = false }: { large?: boolean }): JSX.Element { return <span className={`dsh-partner-weixin-glyph${large ? ' is-large' : ''}`} aria-hidden="true"><i /><b /></span> }
function TabButton({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: ReactNode; children: ReactNode }): JSX.Element { return <button type="button" className={active ? 'is-active' : ''} onClick={onClick}>{icon}<span>{children}</span></button> }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element { return <label className="dsh-partner-field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label> }
function Section({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }): JSX.Element { return <header className="dsh-partner-section"><small>{eyebrow}</small><h2>{title}</h2><p>{detail}</p></header> }
function State({ title, detail, action, compact = false }: { title: string; detail?: string; action?: ReactNode; compact?: boolean }): JSX.Element { return <div className={`dsh-partner-state${compact ? ' is-compact' : ''}`}><IconAgentPresetOutline16 size={20} /><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div> }
function companionDraft(companion: CompanionView): { name: string; role: string; description: string; instructions: string; presetId: string; provider: string; model: string; capabilities: Capability[] } { return { name: companion.name, role: companion.role, description: companion.description, instructions: companion.instructions, presetId: companion.presetId ?? '', provider: companion.provider ?? '', model: companion.model ?? '', capabilities: [...companion.capabilities] } }
function relativeTime(value: number): string { const minutes = Math.floor((Date.now() - value) / 60_000); return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前` }
function memoryKind(value: MemoryView['kind']): string { return ({ profile: '画像', preference: '偏好', task: '任务', event: '事件', relationship: '关系', emotion: '情绪信号' })[value] }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function waitForClientSession(ctx: ClientContext, sessionId: string): Promise<void> {
  const id = sessionId as SessionId
  const sessions = clientSessions(ctx)
  if (sessions.list.getSnapshot().byId[id] !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let stop = (): void => {}
    const timeout = window.setTimeout(() => { stop(); reject(new Error('伙伴会话尚未同步到网页，请稍后重试')) }, 5_000)
    stop = sessions.list.subscribe(() => {
      if (sessions.list.getSnapshot().byId[id] === undefined) return
      window.clearTimeout(timeout)
      stop()
      resolve()
    })
  })
}
function clientSessions(ctx: ClientContext): ISessions { return ctx.sessions as unknown as ISessions }
function installStyles(): () => void { let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null; if (!style) { style = document.createElement('style'); style.id = STYLE_ID; style.textContent = cssText; document.head.append(style) } return () => style?.remove() }
