import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { activatePluginWorkspace, observePluginWorkspace } from './workspace-ownership.js'
import {
  IconAgentPresetOutline16, IconCheckOutline14, IconChevronDownOutline14, IconChevronLeftOutline14,
  IconDataOutline16, IconEditOutline16, IconLinkOutline16, IconPlusOutline16,
  IconRefreshOutline16, IconTrashOutline16, IconUserOutline16, IconBrowseOutline16, IconListPenOutline16, IconPlayOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'
import cssText from './client.css'
import { api, loadPartner, type AutomationView, type Capability, type ChannelView, type CompanionView, type ConcernActivityView, type ConcernObservationView, type ConcernSourceView, type ConcernView, type DailyReflectionView, type LoginView, type MemoryGraphView, type MemoryRelationView, type MemoryView, type ModelCatalogView, type PartnerSnapshot, type UserProfileSnapshotView } from './client-api.js'
import { useWorkspaceTopAnchor } from './sidebar-anchor.js'
import { futureTime } from './time-format.js'
import { GlassSurface } from './glass-surface.js'
import { CompanionSkillSettings, SkillsPanel } from './ui/skills-panel.js'
import { TaskBoardPanel } from './ui/task-board-panel.js'
import { SchedulePanel } from './ui/schedule-panel.js'

const PLUGIN_ID = '@lemoncat7/dsh-partner'
const STYLE_ID = `${PLUGIN_ID}/client`
type SidebarProps = PropsRuntime<'sidebar.footer.action'>
type ConversationProps = PropsRuntime<'conversation'>
type CompanionTab = 'home' | 'identity' | 'capabilities' | 'weixin' | 'memory'
type WorkspacePage = 'skills' | 'board' | 'schedules'
type View = CompanionTab | WorkspacePage

const WORKSPACE_PAGES = new Set<View>(['skills', 'board', 'schedules'])

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
    <div className={`dsh-partner-sidebar-list${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <div className="dsh-partner-sidebar-list-inner">
        <button type="button" tabIndex={open ? 0 : -1} className={`dsh-partner-sidebar-row${props.controller.isOpen() ? ' is-active' : ''}`} onClick={() => launch()}>
          <span className="dsh-partner-sidebar-symbol"><IconAgentPresetOutline16 size={16} /></span><span><strong>伙伴面板</strong><small>{snapshot ? `${snapshot.companions.length} 位伙伴 · ${snapshot.channels.filter(item => item.runtimeStatus === 'running').length} 个微信在线` : '身份、能力与渠道'}</small></span><i className={snapshot?.channels.some(item => item.runtimeStatus === 'running') ? 'is-online' : ''} />
        </button>
      </div>
    </div>
  </section>
}

function PartnerWorkspace({ controller }: ConversationProps & { controller: Controller }): JSX.Element {
  const [snapshot, setSnapshot] = useState<PartnerSnapshot>()
  const [selectedId, setSelectedId] = useState(controller.selected())
  const [view, setView] = useState<View>('home')
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
      await refresh(); setSelectedId(companion.id); setView('identity')
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
  const workspacePage = WORKSPACE_PAGES.has(view)
  const openCompanion = (id: string): void => { setSelectedId(id); setView('home') }
  return <main className="dsh-partner-workspace">
    <header className="dsh-partner-topbar"><div><button type="button" data-xiaohei-workspace-close onClick={controller.close} aria-label="返回会话" title="返回会话"><IconChevronLeftOutline14 size={15} /></button><IconAgentPresetOutline16 size={18} /><span><strong>伙伴</strong><small>长期身份与微信渠道</small></span></div><nav className="dsh-partner-mobile-workspace-nav" aria-label="伙伴工作区快捷入口"><button type="button" className={view === 'skills' ? 'is-active' : ''} aria-label="Skill 市场" onClick={() => setView('skills')}><IconBrowseOutline16 size={16} /><span>Skill</span></button><button type="button" className={view === 'board' ? 'is-active' : ''} aria-label="任务看板" onClick={() => setView('board')}><IconListPenOutline16 size={16} /><span>看板</span></button><button type="button" className={view === 'schedules' ? 'is-active' : ''} aria-label="定时任务" onClick={() => setView('schedules')}><IconPlayOutline16 size={16} /><span>定时</span></button></nav></header>
    <div className="dsh-partner-grid">
      <aside className="dsh-partner-roster">
        <div className="dsh-partner-roster-title"><span><small>COMPANIONS</small><strong>伙伴名册</strong></span><button type="button" onClick={() => { void create() }} aria-label="新建伙伴"><IconPlusOutline16 size={16} /></button></div>
        <div className="dsh-partner-roster-list">{snapshot?.companions.map(companion => {
          const channel = snapshot.channels.find(item => item.companionId === companion.id)
          return <button type="button" key={companion.id} className={!workspacePage && selectedId === companion.id ? 'is-active' : ''} onClick={() => openCompanion(companion.id)}>
            <Avatar name={companion.name} /><span><strong>{companion.name}</strong><small>{companion.role}</small></span><i className={channel?.runtimeStatus === 'running' ? 'is-online' : ''} title={channel ? channel.runtimeStatus : '未连接渠道'} />
          </button>
        })}</div>
        <nav className="dsh-partner-workspace-nav" aria-label="伙伴工作区">
          <button type="button" className={view === 'skills' ? 'is-active' : ''} aria-current={view === 'skills' ? 'page' : undefined} onClick={() => setView('skills')}><span><IconBrowseOutline16 size={16} /></span><strong>Skill 市场</strong><small>安装与管理能力</small></button>
          <button type="button" className={view === 'board' ? 'is-active' : ''} aria-current={view === 'board' ? 'page' : undefined} onClick={() => setView('board')}><span><IconListPenOutline16 size={16} /></span><strong>任务看板</strong><small>协作、委派与验收</small></button>
          <button type="button" className={view === 'schedules' ? 'is-active' : ''} aria-current={view === 'schedules' ? 'page' : undefined} onClick={() => setView('schedules')}><span><IconPlayOutline16 size={16} /></span><strong>定时任务</strong><small>选择伙伴周期执行</small></button>
        </nav>
        <div className="dsh-partner-roster-note"><IconLinkOutline16 size={16} /><span><strong>身份与渠道分离</strong><small>微信只负责收发，权限仍由 DSH 工具决定。</small></span></div>
      </aside>
      <section className={`dsh-partner-stage${workspacePage ? ' is-workspace-page' : ''}`}>
        {loading ? <State title="正在读取伙伴…" /> : workspacePage ? <div className="dsh-partner-stage-scroll is-workspace-page">
          {view === 'skills' && <SkillsPanel />}
          {view === 'board' && <TaskBoardPanel />}
          {view === 'schedules' && <SchedulePanel companions={snapshot?.companions ?? []} />}
        </div> : selected === undefined ? <State title="创建第一个伙伴" detail="伙伴会保存独立身份、能力和微信会话。" action={<button onClick={() => { void create() }}>新建伙伴</button>} /> : <>
          <div className="dsh-partner-identity"><Avatar name={selected.name} /><span><small>ACTIVE COMPANION</small><h1>{selected.name}</h1><p>{selected.description || selected.role}</p></span><Status channel={snapshot?.channels.find(item => item.companionId === selected.id)} /></div>
          <nav className="dsh-partner-tabs" aria-label="伙伴配置">
            <TabButton active={view === 'home'} onClick={() => setView('home')} icon={<IconAgentPresetOutline16 size={16} />}>总览</TabButton>
            <TabButton active={view === 'identity'} onClick={() => setView('identity')} icon={<IconEditOutline16 size={16} />}>身份</TabButton>
            <TabButton active={view === 'capabilities'} onClick={() => setView('capabilities')} icon={<IconAgentPresetOutline16 size={16} />}>能力</TabButton>
            <TabButton active={view === 'weixin'} onClick={() => setView('weixin')} icon={<WeixinGlyph />}>微信</TabButton>
            <TabButton active={view === 'memory'} onClick={() => setView('memory')} icon={<IconDataOutline16 size={16} />}>记忆</TabButton>
          </nav>
          <div className="dsh-partner-stage-scroll">
            {view === 'home' && <HomePanel companion={selected} snapshot={snapshot!} navigate={setView} openSession={openSession} renewSession={renewSession} />}
            {view === 'identity' && <IdentityEditor companion={selected} count={snapshot?.companions.length ?? 1} onChanged={refresh} />}
            {view === 'capabilities' && <CapabilityEditor companion={selected} presets={snapshot?.presets ?? []} onChanged={refresh} />}
            {view === 'weixin' && <WeixinPanel companion={selected} snapshot={snapshot!} onChanged={refresh} />}
            {view === 'memory' && <MemoryPanel companion={selected} snapshot={snapshot!} openSession={openSession} renewSession={renewSession} onChanged={refresh} />}
          </div>
        </>}
        {error && <p className="dsh-partner-error" role="alert">{error}</p>}
      </section>
    </div>
  </main>
}

function HomePanel({ companion, snapshot, navigate, openSession, renewSession }: { companion: CompanionView; snapshot: PartnerSnapshot; navigate(tab: CompanionTab): void; openSession(routeId: string, sessionId: string): Promise<void>; renewSession(routeId: string): Promise<void> }): JSX.Element {
  const channel = snapshot.channels.find(item => item.companionId === companion.id)
  const sessions = snapshot.sessions.filter(item => item.companionId === companion.id)
  const pending = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'pending').length : 0
  const approved = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'approved').length : 0
  const capabilities = companion.capabilities.map(item => ({ knowledge: '知识库', skills: 'Skill', collaboration: '伙伴协作', ssh: 'SSH', git: 'Git' })[item])
  const online = channel?.runtimeStatus === 'running'
  const latestSession = sessions.reduce<(typeof sessions)[number] | undefined>((latest, item) => latest === undefined || item.lastMessageAt > latest.lastMessageAt ? item : latest, undefined)
  return <div className="dsh-partner-home">
    <header className="dsh-partner-home-heading">
      <span><small>工作台</small><h2>{online ? `${companion.name} 正在微信待命` : `连接 ${companion.name} 的第一条渠道`}</h2></span>
      <p>{online ? '消息、授权与上下文边界都在这里汇总。' : '伙伴身份已经就绪，连接微信后即可开始持续工作。'}</p>
    </header>

    <GlassSurface as="section" interactive className={`dsh-partner-home-channel${online ? ' is-online' : ''}`} borderRadius={20} distortionScale={-16} saturation={1.08}>
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
    </GlassSurface>

    <div className="dsh-partner-home-details">
      <GlassSurface as="section" interactive className="dsh-partner-home-profile" borderRadius={15} distortionScale={-11} saturation={1.06}>
        <header><span><IconUserOutline16 size={16} /></span><div><small>伙伴底稿</small><strong>{companion.role}</strong></div><button type="button" onClick={() => navigate('identity')}>编辑</button></header>
        <blockquote>{companion.instructions || companion.description || '尚未设置长期行为准则。'}</blockquote>
      </GlassSurface>
      <GlassSurface as="section" interactive className="dsh-partner-home-runtime" borderRadius={15} distortionScale={-11} saturation={1.06}>
        <header><span><IconAgentPresetOutline16 size={16} /></span><div><small>运行能力</small><strong>{companion.presetId || 'DSH 默认 Preset'}</strong></div><button type="button" onClick={() => navigate('capabilities')}>调整</button></header>
        <div className="dsh-partner-home-capability-list">{capabilities.length ? capabilities.map(item => <em key={item}>{item}</em>) : <small>尚未声明能力范围</small>}</div>
      </GlassSurface>
      <GlassSurface as="section" interactive className="dsh-partner-home-continuity" borderRadius={15} distortionScale={-11} saturation={1.06}>
        <header><span><IconDataOutline16 size={16} /></span><div><small>会话连续性</small><strong>{sessions.length ? `${sessions.length} 个共享会话` : '等待第一条消息'}</strong></div><button type="button" onClick={() => latestSession === undefined ? navigate('memory') : latestSession.archived ? void renewSession(latestSession.id) : void openSession(latestSession.id, latestSession.sessionId)}>{latestSession === undefined ? '查看' : latestSession.archived ? '开始新会话' : '打开会话'}</button></header>
        <p>{sessions.length ? `最近活动于 ${relativeTime(Math.max(...sessions.map(item => item.lastMessageAt)))}` : '微信联系人通过配对后，将在这里建立独立上下文。'}</p>
      </GlassSurface>
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
    { id: 'skills', title: 'Skill', detail: '使用为当前伙伴单独启用的 Skill 能力与工作流程。' },
    { id: 'collaboration', title: '伙伴协作', detail: '查看授权伙伴的公开能力，通过 @伙伴 和看板分配真实任务。' },
    { id: 'ssh', title: 'SSH', detail: '通过 SSH 插件授权的主机与命令边界工作。' },
    { id: 'git', title: 'Git', detail: '预留 Git 工具能力，仍需对应插件实际安装。' },
  ]
  const selectedProvider = form.provider || modelCatalog?.defaultSelection.provider || ''
  const modelOptions = modelCatalog?.providers.find(item => item.id === selectedProvider)?.models ?? []
  const currentModelMissing = Boolean(form.model) && !modelOptions.some(item => item.id === form.model)
  return <div className="dsh-partner-form is-capabilities"><Section eyebrow="COMPOSITION" title="能力组合" detail="伙伴声明意图范围；真正可调用的工具仍来自所选 Agent Preset，并继续执行各插件权限。" />
    <Field label="Agent Preset" hint="决定这个伙伴实际加载哪些工具、技能和系统提示。"><select value={form.presetId} onChange={event => setForm({ ...form, presetId: event.target.value })}><option value="">跟随 DSH 默认 Preset</option>{presets.filter(item => !item.broken).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
    <div className="dsh-partner-capabilities">{choices.map(choice => <GlassSurface as="button" interactive type="button" key={choice.id} className={form.capabilities.includes(choice.id) ? 'is-active' : ''} borderRadius={12} distortionScale={-9} saturation={1.05} aria-pressed={form.capabilities.includes(choice.id)} onClick={() => toggle(choice.id)}><span>{form.capabilities.includes(choice.id) && <IconCheckOutline14 size={14} />}</span><strong>{choice.title}</strong><small>{choice.detail}</small></GlassSurface>)}</div>
    {form.capabilities.includes('skills') && companion.capabilities.includes('skills') && <CompanionSkillSettings companionId={companion.id} />}
    {form.capabilities.includes('skills') && !companion.capabilities.includes('skills') && <p className="dsh-partner-inline-note">先应用能力组合，再为当前伙伴选择具体 Skill。</p>}
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
    {!channel && !login && <GlassSurface as="div" interactive className="dsh-partner-weixin-connect" borderRadius={15} distortionScale={-10} saturation={1.06}><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><strong>把 {companion.name} 带到微信</strong><p>扫码后，机器人凭据直接保存进 DSH 凭据库，不会显示在浏览器或普通配置文件中。</p><ul><li>私聊首次联系必须审批</li><li>联系人之间上下文完全隔离</li><li>工具权限不会因微信身份自动扩大</li></ul></span><button type="button" disabled={busy} onClick={() => { void begin() }}>{busy ? '正在申请二维码…' : '扫码连接微信'}</button></GlassSurface>}
    {login && <GlassSurface as="div" interactive className="dsh-partner-qr" borderRadius={16} distortionScale={-10} saturation={1.06}><div className="dsh-partner-qr-code">{login.qrContent && <QRCodeSVG value={login.qrContent} size={176} level="M" />}</div><span><small>WECHAT ILINK BOT</small><strong>{login.phase === 'scanned' ? '已扫码，请在微信确认' : login.phase === 'expired' ? '二维码已过期' : login.phase === 'error' ? '连接失败' : '使用微信扫码'}</strong><p>{login.error || (login.phase === 'scanned' ? '确认后会自动启动渠道，不需要复制 Token。' : '二维码约 5 分钟有效。此页面可以安全地保持打开。')}</p>{(login.phase === 'expired' || login.phase === 'error') && <button type="button" onClick={() => { setLogin(undefined); void begin() }}><IconRefreshOutline16 size={16} />重新生成</button>}</span></GlassSurface>}
    {channel && <>
      <GlassSurface as="div" interactive className="dsh-partner-channel-card" borderRadius={14} distortionScale={-10} saturation={1.06}><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><small>WECHAT CHANNEL</small><strong>{channel.name}</strong><p>{channel.accountId}</p></span><Status channel={channel} /><button type="button" className="dsh-partner-switch" data-on={channel.enabled} disabled={busy} aria-label={channel.enabled ? '停用微信渠道' : '启用微信渠道'} onClick={() => { void toggle() }}><i /></button></GlassSurface>
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
  const [profiles, setProfiles] = useState<UserProfileSnapshotView[]>([])
  const [concernActivity, setConcernActivity] = useState<ConcernActivityView>({ concerns: [], observations: [] })
  const [newConcern, setNewConcern] = useState('')
  const [memoryRevision, setMemoryRevision] = useState(0)
  const [editing, setEditing] = useState<MemoryView>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogView>()
  const loadMemory = useCallback(async () => {
    const [result, activity] = await Promise.all([api<{ memories: MemoryView[]; reflections: DailyReflectionView[]; profiles: UserProfileSnapshotView[] }>(`/companions/${companion.id}/memory`), api<ConcernActivityView>(`/companions/${companion.id}/concerns`)])
    setMemories(result.memories); setReflections(result.reflections); setProfiles(result.profiles); setConcernActivity(activity); setMemoryRevision(value => value + 1)
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
  const trigger = async (concernId?: string): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await api<{ checked: boolean; sent: boolean; reason?: string }>(`/companions/${companion.id}/heartbeat/trigger`, {
        method: 'POST', body: JSON.stringify(concernId ? { concernId } : {}),
      })
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
  const addConcern = async (): Promise<void> => {
    const subject = newConcern.trim()
    if (!subject) return
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await api(`/companions/${companion.id}/concerns`, { method: 'POST', body: JSON.stringify({ subject }) })
      setNewConcern(''); setNotice('伙伴会继续留意这件事')
      await loadMemory()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const actConcern = async (item: ConcernView, action: 'watch' | 'ignore' | 'prioritize' | 'resolve'): Promise<void> => {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await api(`/companions/${companion.id}/concerns/${encodeURIComponent(item.id)}/action`, { method: 'POST', body: JSON.stringify({ action }) })
      setNotice(action === 'ignore' ? '伙伴不再关注这件事' : action === 'resolve' ? '已标记为解决' : action === 'prioritize' ? '已提高关注' : '会继续留意')
      await loadMemory()
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  return <div className="dsh-partner-form is-memory"><Section eyebrow="CONTINUITY" title="会话记忆" detail="这里展示渠道会话边界。知识库仍由知识库插件管理，伙伴不会把不同微信联系人的原始上下文混在一起。" />
    <div className="dsh-partner-metrics"><article><small>渠道会话</small><strong>{sessions.length}</strong><p>每位联系人独立</p></article><article><small>长期记忆</small><strong>{memories.filter(item => item.status === 'active').length}</strong><p>{reflections.length} 篇每日回顾</p></article><article><small>最近心跳</small><strong>{heartbeat?.lastCheckedAt ? relativeTime(heartbeat.lastCheckedAt) : '尚未'}</strong><p>{heartbeat?.lastError ? '上次执行异常' : `今日发送 ${heartbeat?.sentCount ?? 0} 次`}</p></article></div>

    <div className="dsh-partner-automation-grid"><section className="dsh-partner-automation">
      <header><span><strong>学习与长期记忆</strong><small>按联系人归档完整对话，提炼每日回顾和结构化记忆，并在相关话题出现时召回。</small></span><button type="button" className="dsh-partner-switch" data-on={automation.memory.enabled} aria-label="启用伙伴学习" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, enabled: !current.memory.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-memory-model"><Field label="保留期限"><select value={automation.memory.retentionDays} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, retentionDays: Number(event.target.value) } }))}><option value={0}>永久保留</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>1 年</option><option value={1095}>3 年</option></select></Field><Field label="提炼 Provider" hint="默认继承伙伴"><select value={automation.memory.provider ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, provider: event.target.value, model: '' } }))}><option value="">跟随伙伴 · {inheritedProvider || 'DSH 默认'}</option>{modelCatalog?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></Field><Field label="提炼模型" hint="默认继承伙伴"><select value={automation.memory.model ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, model: event.target.value } }))}><option value="">跟随伙伴 · {companion.model || modelCatalog?.defaultSelection.model || 'DSH 默认'}</option>{modelOptions.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></Field></div>
      <div className="dsh-partner-review-policy"><button type="button" className="dsh-partner-switch" data-on={automation.memory.dailyReviewEnabled} aria-label="启用每日终审" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewEnabled: !current.memory.dailyReviewEnabled } }))}><i /></button><span><strong>每日终审</strong><small>次日自动合并重复、纠正偏差并建立记忆关系</small></span><label><select aria-label="每日终审时间" value={automation.memory.dailyReviewHour} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewHour: Number(event.target.value) } }))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label><button type="button" disabled={busy || reflections.length === 0} onClick={() => { void review() }}>立即终审</button></div>
    </section>

    <section className="dsh-partner-automation">
      <header><span><strong>持续感知</strong><small>伙伴只观察尚未闭环的事情是否出现新变化，并由克制的打扰策略决定何时告诉你。</small></span><button type="button" className="dsh-partner-switch" data-on={automation.heartbeat.enabled} aria-label="启用伙伴心跳" onClick={() => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, enabled: !current.heartbeat.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-heartbeat">
        <Field label="检查间隔"><select value={automation.heartbeat.intervalMinutes} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, intervalMinutes: Number(event.target.value) } }))}><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={180}>3 小时</option><option value={360}>6 小时</option><option value={720}>12 小时</option><option value={1440}>24 小时</option></select></Field>
        <Field label="免打扰开始"><input type="number" min={0} max={23} value={automation.heartbeat.quietStartHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietStartHour: Number(event.target.value) } }))} /></Field>
        <Field label="免打扰结束"><input type="number" min={0} max={23} value={automation.heartbeat.quietEndHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietEndHour: Number(event.target.value) } }))} /></Field>
        <Field label="每日上限"><select value={automation.heartbeat.dailyLimit} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, dailyLimit: Number(event.target.value) } }))}><option value={0}>不限</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option><option value={8}>8 次</option></select></Field>
      </div>
      <ConcernBoard companionId={companion.id} activity={concernActivity} value={newConcern} busy={busy} onValue={setNewConcern} onAdd={() => { void addConcern() }} onCheck={item => { void trigger(item.id) }} onAct={(item, action) => { void actConcern(item, action) }} />
      {heartbeat?.lastError && <p className="dsh-partner-inline-error">{heartbeat.lastError}</p>}
      <div className="dsh-partner-automation-actions"><button type="button" disabled={busy || sessions.length === 0} onClick={() => { void trigger() }}>检查到期项</button><button type="button" className="is-primary" disabled={busy} onClick={() => { void save() }}>{busy ? '正在处理…' : '保存设置'}</button></div>
    </section></div>

    {notice && <p className="dsh-partner-inline-notice"><IconCheckOutline14 size={14} />{notice}</p>}
    {error && <p className="dsh-partner-inline-error">{error}</p>}

    <MemoryLibrary companionId={companion.id} revision={memoryRevision} profiles={profiles} memories={memories} reflections={reflections} editing={editing} busy={busy} setEditing={setEditing} save={() => { void saveMemory() }} remove={item => { void deleteMemory(item) }} />

    <div className="dsh-partner-section-heading"><span><small>SESSIONS</small><strong>共享会话</strong></span></div>
    <div className="dsh-partner-session-list">{sessions.map(item => <article key={item.id} data-archived={item.archived}><span><IconDataOutline16 size={16} /></span><div><strong>微信联系人 · {item.userId.slice(-6)}</strong><small>{item.archived ? '已归档 · 长期记忆保留' : `${item.sessionId} · ${new Date(item.lastMessageAt).toLocaleString()}`}</small></div><button type="button" className={item.archived ? 'is-primary' : undefined} onClick={() => { if (item.archived) void renewSession(item.id); else void openSession(item.id, item.sessionId) }}>{item.archived ? '开始新会话' : '打开会话'}</button></article>)}{sessions.length === 0 && <State title="还没有共享会话" detail="联系人完成配对并发来第一条消息后，伙伴会创建网页与微信共用的会话。" compact />}</div>
  </div>
}

function ConcernBoard({ companionId, activity, value, busy, onValue, onAdd, onCheck, onAct }: {
  companionId: string; activity: ConcernActivityView; value: string; busy: boolean; onValue(value: string): void; onAdd(): void
  onCheck(item: ConcernView): void
  onAct(item: ConcernView, action: 'watch' | 'ignore' | 'prioritize' | 'resolve'): void
}): JSX.Element {
  const visible = activity.concerns.filter(item => item.state !== 'archived')
  const active = visible.filter(item => item.state !== 'resolved')
  const resolved = visible.filter(item => item.state === 'resolved')
  const latest = new Map([...activity.observations].reverse().map(item => [item.concernId, item]))
  const [composing, setComposing] = useState(false)
  const [expandedId, setExpandedId] = useState<string>()
  const [visibleCount, setVisibleCount] = useState(5)
  const [mention, setMention] = useState<{ start: number; end: number; query: string }>()
  const [sources, setSources] = useState<ConcernSourceView[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string>()
  const [activeSource, setActiveSource] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()
  const shown = active.slice(0, visibleCount)
  const suggestionsOpen = composing && mention !== undefined
  useEffect(() => {
    if (!suggestionsOpen || mention === undefined) {
      setSources([]); setSourcesLoading(false); setSourceError(undefined); return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSourcesLoading(true); setSourceError(undefined)
      const params = new URLSearchParams({ q: mention.query })
      void api<{ items: ConcernSourceView[] }>(`/companions/${encodeURIComponent(companionId)}/concern-sources?${params}`).then(result => {
        if (!controller.signal.aborted) { setSources(result.items); setActiveSource(0) }
      }).catch(reason => {
        if (!controller.signal.aborted) { setSources([]); setSourceError(message(reason)) }
      }).finally(() => { if (!controller.signal.aborted) setSourcesLoading(false) })
    }, 150)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [companionId, mention?.query, suggestionsOpen])
  const submit = (event: FormEvent): void => { event.preventDefault(); onAdd(); setComposing(false); setMention(undefined) }
  const chooseSource = (source: ConcernSourceView): void => {
    if (mention === undefined) return
    const next = `${value.slice(0, mention.start)}${source.token} ${value.slice(mention.end)}`
    const cursor = mention.start + source.token.length + 1
    onValue(next); setMention(undefined); setSources([])
    window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor, cursor) })
  }
  return <section className="dsh-partner-concern-board" aria-labelledby="partner-concerns-title">
    <header><span><strong id="partner-concerns-title">伙伴在意的事 <b>{active.length}</b></strong><p>尚未闭环、值得继续留意的事情</p></span><button type="button" aria-expanded={composing} onClick={() => setComposing(current => !current)}><IconPlusOutline16 size={14} />交代一件事</button></header>
    {composing && <form className="dsh-partner-concern-compose" onSubmit={submit}><label><span>需要留意的事</span><div className="dsh-partner-concern-input-wrap"><input
      ref={inputRef} autoFocus value={value} maxLength={300} placeholder="输入 @ 选择文件或知识文档"
      role="combobox" aria-autocomplete="list" aria-expanded={suggestionsOpen} aria-controls={suggestionsOpen ? listboxId : undefined}
      aria-activedescendant={suggestionsOpen && sources[activeSource] ? `${listboxId}-option-${activeSource}` : undefined}
      onChange={event => { onValue(event.target.value); setMention(activeMention(event.target.value, event.target.selectionStart ?? event.target.value.length)) }}
      onClick={event => setMention(activeMention(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length))}
      onKeyDown={event => {
        if (!suggestionsOpen) return
        if (event.key === 'ArrowDown') { event.preventDefault(); setActiveSource(index => sources.length === 0 ? 0 : (index + 1) % sources.length) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveSource(index => sources.length === 0 ? 0 : (index - 1 + sources.length) % sources.length) }
        else if (event.key === 'Enter' && sources[activeSource]) { event.preventDefault(); chooseSource(sources[activeSource]) }
        else if (event.key === 'Escape') { event.preventDefault(); setMention(undefined) }
      }}
    />{suggestionsOpen && <div id={listboxId} className="dsh-partner-concern-sources" role="listbox" aria-label="可引用的文件与知识文档">
      {sourcesLoading ? <p role="status">正在查找可引用内容…</p> : sourceError ? <p role="status">候选加载失败：{sourceError}</p> : sources.length === 0 ? <p role="status">没有找到匹配的文件或已挂载知识文档</p> : <>
        {sources.map((source, index) => <button
          type="button" role="option" id={`${listboxId}-option-${index}`} key={`${source.kind}:${source.token}`}
          aria-selected={index === activeSource} data-kind={source.kind} onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => setActiveSource(index)} onClick={() => chooseSource(source)}
        ><span>{source.kind === 'file' ? <IconDataOutline16 size={15} /> : <IconLinkOutline16 size={15} />}</span><strong>{source.label}</strong><small>{source.detail}</small></button>)}
      </>}
    </div>}</div><small className="dsh-partner-concern-compose-hint">输入 <b>@</b> 会列出当前会话文件和已挂载的知识文档，也可以继续输入关键词筛选。</small></label><div><button type="button" onClick={() => { setComposing(false); setMention(undefined); onValue('') }}>取消</button><button type="submit" className="is-primary" disabled={busy || !value.trim()}>让伙伴记着</button></div></form>}
    <div className="dsh-partner-concern-list" role="list">
      {active.length === 0 ? <p className="dsh-partner-concern-empty">最近没有未闭环的事。你也可以直接对伙伴说“这个帮我留意”。</p> : shown.map(item => {
        const observation = latest.get(item.id)
        const expanded = expandedId === item.id
        const status = observation ? concernObservationStatus(observation) : item.state === 'active' ? '正在留意' : '暂时记着'
        return <article key={item.id} role="listitem" data-state={item.state} data-expanded={expanded}>
          <button type="button" className="dsh-partner-concern-row" aria-expanded={expanded} onClick={() => setExpandedId(current => current === item.id ? undefined : item.id)}>
            <span className="dsh-partner-concern-state"><i />{status}</span><span className="dsh-partner-concern-copy"><strong>{item.subject}</strong><small>{observation ? observation.event : item.reason}</small></span><span className="dsh-partner-concern-time" title={`计划于 ${new Date(item.nextCheckAt).toLocaleString()} 再次留意`}><small>下次留意</small><strong>{futureTime(item.nextCheckAt)}</strong></span><IconChevronDownOutline14 size={14} />
          </button>
          {expanded && <div className="dsh-partner-concern-detail"><p>{item.reason}</p>{observation && <><blockquote>{observation.event}</blockquote><div className="dsh-partner-concern-decision" data-decision={observation.decision}><strong>{concernObservationStatus(observation)}</strong><span>{observation.decisionReason || concernObservationExplanation(observation)}</span><small>打扰分数 {Math.round(observation.interruptScore * 100)}{observation.notificationRuleEffect !== 'auto' && observation.notificationRuleReason ? ` · 知识规则：${observation.notificationRuleReason}` : ''}</small></div></>}{item.resources.length > 0 && <div className="dsh-partner-concern-resources">{item.resources.map(resource => <span key={`${resource.kind}:${resource.locator}`}>{resource.kind === 'file' ? '文件' : '知识'} · {resource.label}</span>)}</div>}<small>{item.origin === 'explicit' ? '你明确交代' : '伙伴从对话中注意到'} · {watchKindLabel(item.watchKind)}</small><div className="dsh-partner-concern-actions" aria-label={`${item.subject} 的操作`}><button type="button" disabled={busy} onClick={() => onCheck(item)}>立即检查这条</button><button type="button" disabled={busy} onClick={() => onAct(item, 'watch')}>继续留意</button><button type="button" disabled={busy} onClick={() => onAct(item, 'prioritize')}>提高关注</button><button type="button" disabled={busy} onClick={() => onAct(item, 'resolve')}>已经解决</button><button type="button" className="is-danger" disabled={busy} onClick={() => onAct(item, 'ignore')}>别管这个</button></div></div>}
        </article>
      })}
    </div>
    {(active.length > shown.length || visibleCount > 5) && <div className="dsh-partner-concern-more">{active.length > shown.length ? <button type="button" onClick={() => setVisibleCount(count => Math.min(active.length, count + 20))}>再显示 {Math.min(20, active.length - shown.length)} 条</button> : <button type="button" onClick={() => setVisibleCount(5)}>收起列表</button>}</div>}
    {resolved.length > 0 && <details className="dsh-partner-concern-resolved"><summary>已经解决 <b>{resolved.length}</b></summary><div>{resolved.slice(0, 30).map(item => <article key={item.id}><span><IconCheckOutline14 size={13} /></span><strong>{item.subject}</strong><button type="button" disabled={busy} onClick={() => onAct(item, 'watch')}>重新留意</button></article>)}</div></details>}
  </section>
}

function activeMention(value: string, cursor: number): { start: number; end: number; query: string } | undefined {
  const prefix = value.slice(0, cursor)
  const start = prefix.lastIndexOf('@')
  if (start < 0 || (start > 0 && !/\s/u.test(prefix[start - 1] ?? ''))) return undefined
  const fragment = prefix.slice(start + 1)
  if (fragment.startsWith('知识库[')) {
    if (fragment.includes(']')) return undefined
    return { start, end: cursor, query: fragment.slice(4) }
  }
  if (fragment.startsWith('"')) {
    if (fragment.slice(1).includes('"')) return undefined
    return { start, end: cursor, query: fragment.slice(1) }
  }
  if (/\s/u.test(fragment)) return undefined
  return { start, end: cursor, query: fragment }
}

function watchKindLabel(value: ConcernView['watchKind']): string {
  return value === 'knowledge' ? '知识库变化' : value === 'workspace' ? '项目变化' : value === 'web' ? '外部变化' : '按事情判断来源'
}

type MemoryLibraryMode = 'profile' | 'memory' | 'reflection' | 'graph'
const MEMORY_KINDS: Array<MemoryView['kind'] | 'all'> = ['all', 'preference', 'task', 'event', 'relationship', 'emotion']

function MemoryLibrary({ companionId, revision, profiles, memories, reflections, editing, busy, setEditing, save, remove }: {
  companionId: string; revision: number; profiles: UserProfileSnapshotView[]; memories: MemoryView[]; reflections: DailyReflectionView[]; editing: MemoryView | undefined; busy: boolean
  setEditing(value?: MemoryView): void; save(): void; remove(item: MemoryView): void
}): JSX.Element {
  const activeMemories = useMemo(() => memories.filter(item => item.status === 'active' && item.kind !== 'profile'), [memories])
  const profileMemories = useMemo(() => memories.filter(item => item.status === 'active' && item.kind === 'profile'), [memories])
  const [mode, setMode] = useState<MemoryLibraryMode>('profile')
  const [kind, setKind] = useState<MemoryView['kind'] | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>()
  const [selectedDate, setSelectedDate] = useState<string>()
  const [graph, setGraph] = useState<MemoryGraphView>()
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState<string>()
  const [graphRequest, setGraphRequest] = useState(0)
  useEffect(() => {
    setGraph(undefined); setGraphError(undefined); setGraphLoading(false)
  }, [companionId, revision])
  useEffect(() => {
    if (mode !== 'graph' || graph !== undefined) return
    const controller = new AbortController()
    setGraphLoading(true); setGraphError(undefined)
    void api<MemoryGraphView>(`/companions/${companionId}/memory/graph`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setGraph(result) })
      .catch(reason => { if (!controller.signal.aborted) setGraphError(message(reason)) })
      .finally(() => { if (!controller.signal.aborted) setGraphLoading(false) })
    return () => controller.abort()
  }, [companionId, graph, graphRequest, mode, revision])
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
    <header className="dsh-partner-library-header"><span><small>MEMORY LIBRARY</small><strong>伙伴记忆库</strong><p>查看伙伴如何从长期对话中认识你，以及这些理解怎样随证据变化。</p></span><nav aria-label="记忆内容"><button type="button" className={mode === 'profile' ? 'is-active' : ''} onClick={() => setMode('profile')}>人物画像 <b>{profiles.length}</b></button><button type="button" className={mode === 'memory' ? 'is-active' : ''} onClick={() => setMode('memory')}>话题记忆 <b>{activeMemories.length}</b></button><button type="button" className={mode === 'reflection' ? 'is-active' : ''} onClick={() => setMode('reflection')}>每日回顾 <b>{reflections.length}</b></button><button type="button" className={mode === 'graph' ? 'is-active' : ''} onClick={() => setMode('graph')}>关系图谱 <b>{graph?.relations.length ?? '—'}</b></button></nav></header>
    {mode !== 'profile' && <div className="dsh-partner-library-tools"><label><span className="sr-only">搜索记忆</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={mode === 'memory' ? '搜索主题或记忆内容' : '搜索日期、总结或待办'} /></label>{mode === 'memory' && <div className="dsh-partner-memory-kinds">{MEMORY_KINDS.map(value => <button type="button" key={value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{value === 'all' ? '全部' : memoryKind(value)}</button>)}</div>}</div>}
    {mode === 'profile' ? <ProfileLibrary profiles={profiles} memories={profileMemories} editing={editing} busy={busy} setEditing={setEditing} save={save} remove={remove} /> : mode === 'memory' ? <div className="dsh-partner-library-browser">
      <div className="dsh-partner-library-list" role="list">{filteredMemories.length === 0 ? <State title={activeMemories.length === 0 ? '还没有长期记忆' : '没有匹配的记忆'} detail={activeMemories.length === 0 ? '伙伴完成对话后会自动提炼值得长期保留的信息。' : '换个关键词或类型试试。'} compact /> : filteredMemories.map(item => <button type="button" role="listitem" key={item.id} className={selectedMemory?.id === item.id ? 'is-active' : ''} onClick={() => { setSelectedMemoryId(item.id); setEditing(undefined) }}><span data-kind={item.kind}>{memoryKind(item.kind)}</span><strong>{item.subject}</strong><p>{item.content}</p><small>{relativeTime(item.updatedAt)}</small></button>)}</div>
      <div className="dsh-partner-library-detail">{selectedMemory ? <MemoryCard item={selectedMemory} editing={editing?.id === selectedMemory.id ? editing : undefined} busy={busy} setEditing={setEditing} save={save} remove={() => remove(selectedMemory)} /> : <State title="选择一条记忆" detail="记忆详情会显示在这里。" compact />}</div>
    </div> : mode === 'reflection' ? <div className="dsh-partner-library-browser">
      <div className="dsh-partner-library-list is-diary" role="list">{filteredReflections.length === 0 ? <State title={reflections.length === 0 ? '还没有每日回顾' : '没有匹配的回顾'} detail={reflections.length === 0 ? '每日回顾会在每轮完整对话后持续更新。' : '换个关键词或日期试试。'} compact /> : filteredReflections.map(entry => <button type="button" role="listitem" key={entry.date} className={selectedReflection?.date === entry.date ? 'is-active' : ''} onClick={() => setSelectedDate(entry.date)}><time>{entry.date}</time><strong>{entry.turnCount} 轮交流</strong><p>{entry.summary}</p><small>{entry.openTasks.length} 项待跟进 · {entry.learnings.length} 项理解</small></button>)}</div>
      <div className="dsh-partner-library-detail">{selectedReflection ? <DailyReflectionDetail entry={selectedReflection} /> : <State title="选择一天" detail="当天的总结与待办会显示在这里。" compact />}</div>
    </div> : graphError ? <State title="关系图谱加载失败" detail={graphError} action={<button type="button" onClick={() => setGraphRequest(value => value + 1)}>重新加载</button>} /> : graphLoading || graph === undefined ? <State title="正在加载关系图谱" detail="只在需要查看关系时读取审计数据。" /> : <MemoryGraph graph={graph} profiles={profiles} query={normalized} inspect={item => { setEditing(undefined); if (item.kind === 'profile') setMode('profile'); else { setSelectedMemoryId(item.id); setMode('memory') } }} />}
  </section>
}

function ProfileLibrary({ profiles, memories, editing, busy, setEditing, save, remove }: {
  profiles: UserProfileSnapshotView[]; memories: MemoryView[]; editing: MemoryView | undefined; busy: boolean
  setEditing(value?: MemoryView): void; save(): void; remove(item: MemoryView): void
}): JSX.Element {
  const [selectedScopeId, setSelectedScopeId] = useState<string>()
  const selected = profiles.find(item => item.scopeId === selectedScopeId) ?? profiles[0]
  if (!selected) return <State title="还没有联系人画像" detail="联系人开始和伙伴交流后，这里会逐步展示伙伴从明确对话中形成的长期理解。" />
  const activeIds = new Set(selected.entries.map(item => item.id))
  const pending = memories.filter(item => item.scopeId === selected.scopeId && !activeIds.has(item.id))
  return <div className="dsh-partner-profile-browser">
    <div className="dsh-partner-profile-people" role="list" aria-label="联系人画像">
      {profiles.map(profile => <button type="button" role="listitem" key={profile.scopeId} className={profile.scopeId === selected.scopeId ? 'is-active' : ''} onClick={() => { setSelectedScopeId(profile.scopeId); setEditing(undefined) }}>
        <span><IconUserOutline16 size={16} /></span><div><strong>{profile.label}</strong><small>{profile.entries.length > 0 ? `${profile.entries.length} 项稳定理解` : '还在认识中'}</small></div><i aria-hidden="true" />
      </button>)}
    </div>
    <div className="dsh-partner-profile-stage">
      <header className="dsh-partner-profile-heading"><span><small>PARTNER UNDERSTANDING</small><strong>伙伴眼中的 {selected.label}</strong><p>这些内容来自你在对话中的明确表达。伙伴会用它保持理解连续，但不会把画像当成标签反复复述。</p></span><div data-ready={selected.entries.length > 0}><i />{selected.entries.length > 0 ? '上下文基线已就绪' : '等待可靠证据'}</div></header>
      {selected.entries.length > 0 ? <>
        <div className="dsh-partner-profile-meta"><span><small>画像版本</small><strong>{selected.version}</strong></span><span><small>对话依据</small><strong>{selected.evidenceCount} 处</strong></span><span><small>用户确认</small><strong>{selected.lockedCount} 项</strong></span><span><small>最近依据</small><strong>{selected.updatedAt ? relativeTime(selected.updatedAt) : '尚未'}</strong></span></div>
        <div className="dsh-partner-profile-entries">{selected.entries.map(item => <MemoryCard key={item.id} item={item} editing={editing?.id === item.id ? editing : undefined} busy={busy} setEditing={setEditing} save={save} remove={() => remove(item)} />)}</div>
      </> : <State title="伙伴还在认识你" detail="只有明确、稳定并达到可靠标准的长期信息才会进入画像；普通偏好、临时任务和一次性情绪不会放在这里。" compact />}
      {pending.length > 0 && <details className="dsh-partner-profile-pending"><summary>待确认的理解 <b>{pending.length}</b></summary><div>{pending.map(item => <MemoryCard key={item.id} item={item} editing={editing?.id === item.id ? editing : undefined} busy={busy} setEditing={setEditing} save={save} remove={() => remove(item)} />)}</div></details>}
    </div>
  </div>
}

type RelationFilter = MemoryRelationView['kind'] | 'all'
const RELATION_FILTERS: RelationFilter[] = ['all', 'conflicts_with', 'depends_on', 'supports', 'follows', 'about']

function MemoryGraph({ graph, profiles, query, inspect }: { graph: MemoryGraphView; profiles: UserProfileSnapshotView[]; query: string; inspect(item: MemoryView): void }): JSX.Element {
  const byId = new Map(graph.memories.map(item => [item.id, item]))
  const scopeIds = [...new Set(graph.relations.map(item => item.scopeId))]
  const [requestedScopeId, setRequestedScopeId] = useState<string>()
  const scopeId = scopeIds.includes(requestedScopeId ?? '') ? requestedScopeId! : scopeIds[0]
  const [filter, setFilter] = useState<RelationFilter>('all')
  const scoped = graph.relations.filter(item => item.scopeId === scopeId)
  const visible = scoped.filter(item => {
    if (filter !== 'all' && item.kind !== filter) return false
    const source = byId.get(item.sourceMemoryId); const target = byId.get(item.targetMemoryId)
    return !query || `${source?.subject ?? ''} ${source?.content ?? ''} ${target?.subject ?? ''} ${target?.content ?? ''} ${item.label}`.toLocaleLowerCase().includes(query)
  }).sort((left, right) => Number(right.kind === 'conflicts_with') - Number(left.kind === 'conflicts_with') || right.confidence - left.confidence)
  const [selectedRelationId, setSelectedRelationId] = useState<string>()
  const selected = visible.find(item => item.id === selectedRelationId) ?? visible[0]
  const source = selected ? byId.get(selected.sourceMemoryId) : undefined
  const target = selected ? byId.get(selected.targetMemoryId) : undefined
  const label = profiles.find(item => item.scopeId === scopeId)?.label ?? (scopeId ? `联系人 ${scopeId.slice(-6)}` : '当前联系人')
  const conflictCount = scoped.filter(item => item.kind === 'conflicts_with').length
  if (graph.relations.length === 0) return <State title="还没有可靠关系" detail="每日终审只会保存有明确证据的记忆联系，不会为了填满图谱而猜测。" />
  return <div className="dsh-partner-graph-audit">
    <header className="dsh-partner-graph-toolbar"><span><small>关系审计</small><strong>{label} 的理解关系</strong><p>{scoped.length} 条可靠联系{conflictCount > 0 ? `，其中 ${conflictCount} 条需要确认` : '，暂无待确认冲突'}</p></span>{scopeIds.length > 1 && <label><span>联系人</span><select value={scopeId} onChange={event => { setRequestedScopeId(event.target.value); setSelectedRelationId(undefined) }}>{scopeIds.map(value => <option value={value} key={value}>{profiles.find(item => item.scopeId === value)?.label ?? `联系人 ${value.slice(-6)}`}</option>)}</select></label>}</header>
    <nav className="dsh-partner-graph-filters" aria-label="关系类型">{RELATION_FILTERS.map(value => { const count = value === 'all' ? scoped.length : scoped.filter(item => item.kind === value).length; return <button type="button" key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelectedRelationId(undefined) }}>{value === 'all' ? '全部' : relationLabel(value)} <b>{count}</b></button> })}</nav>
    <div className="dsh-partner-graph-browser"><div className="dsh-partner-graph-index" role="list">{visible.length === 0 ? <State title="没有匹配的关系" detail="调整关系类型或搜索关键词后再试。" compact /> : visible.map(item => { const from = byId.get(item.sourceMemoryId); const to = byId.get(item.targetMemoryId); return <button type="button" role="listitem" key={item.id} data-kind={item.kind} className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedRelationId(item.id)}><span>{relationLabel(item.kind)}</span><strong>{from?.subject ?? '已删除记忆'} <i aria-hidden="true">→</i> {to?.subject ?? '已删除记忆'}</strong><p>{item.label}</p><small>{Math.round(item.confidence * 100)}% 可信</small></button> })}</div>
      <div className="dsh-partner-graph-stage">{selected && source && target ? <article data-kind={selected.kind}><header><span>{relationLabel(selected.kind)}</span><strong>{source.subject} <i aria-hidden="true">→</i> {target.subject}</strong><p>{selected.label}</p><small>{relationGuidance(selected.kind)}</small></header><div className="dsh-partner-graph-pair"><GraphMemory item={source} side="起点" inspect={inspect} /><div aria-hidden="true"><i /><span>{relationLabel(selected.kind)}</span><i /></div><GraphMemory item={target} side="关联项" inspect={inspect} /></div><footer><small>最近终审于 {new Date(selected.updatedAt).toLocaleString()}</small><strong>关系置信度 {Math.round(selected.confidence * 100)}%</strong></footer></article> : <State title="选择一条关系" detail="关系两端的记忆与使用方式会显示在这里。" compact />}</div>
    </div>
  </div>
}

function GraphMemory({ item, side, inspect }: { item: MemoryView; side: string; inspect(item: MemoryView): void }): JSX.Element {
  return <section><header><small>{side} · {memoryKind(item.kind)}</small><strong>{item.subject}</strong></header><p>{item.content}</p><button type="button" onClick={() => inspect(item)}>查看并修正</button></section>
}

function relationLabel(kind: MemoryRelationView['kind']): string { return ({ supports: '支持', depends_on: '依赖', about: '关于', conflicts_with: '冲突', follows: '后续' })[kind] }
function relationGuidance(kind: MemoryRelationView['kind']): string {
  return ({
    supports: '回答涉及目标记忆时，可把起点作为明确支持依据，但不能据此补写新事实。',
    depends_on: '处理起点事项时，应同时检查关联项是否成立或已经完成。',
    about: '两条记忆属于同一上下文，召回其中一条时可以补充另一条帮助理解。',
    conflicts_with: '两条理解暂时不能同时作为事实；伙伴应在相关话题出现时指出差异并请求确认。',
    follows: '它们存在明确先后关系，后续判断需要保留这个顺序。',
  })[kind]
}

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
    {item.evidence.length > 0 && <details className="dsh-partner-memory-evidence"><summary>查看对话依据 <b>{item.evidence.length}</b></summary><div>{[...item.evidence].reverse().map(evidence => <blockquote key={`${evidence.turnId}:${evidence.at}`}><p>{evidence.excerpt}</p><time>{new Date(evidence.at).toLocaleString()}</time></blockquote>)}</div></details>}
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
function concernObservationStatus(item: ConcernObservationView): string {
  if (item.decision === 'notify') return item.mentionedAt === undefined ? '待提醒' : '已提醒'
  if (item.decision === 'feed') return '伙伴动态'
  if (item.decision === 'defer') return item.mentionedAt === undefined ? '待顺带提' : '已顺带提'
  return '静默记下'
}
function concernObservationExplanation(item: ConcernObservationView): string {
  if (item.decision === 'notify') return item.mentionedAt === undefined ? '达到主动提醒条件，等待渠道投递' : '已经通过批准的渠道主动提醒'
  if (item.decision === 'feed') return '只显示在伙伴动态，不会自动转成主动提醒'
  if (item.decision === 'defer') return item.mentionedAt === undefined ? '下次出现相关对话时顺带提及' : '已经在相关对话中顺带提及'
  return '仅保留为观察记录，不打扰你'
}
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
