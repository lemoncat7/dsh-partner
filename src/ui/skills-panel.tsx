import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { IconCheckOutline16, IconCloseOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type MarketSkillView, type SkillCatalogView, type SkillMarketNetworkTestView, type SkillMarketNetworkView, type SkillMarketView } from '../client-api.js'
import { CollectionEmpty, CollectionSkeleton, WorkspaceBlock, WorkspaceDialog, WorkspaceHero, WorkspaceNotice, errorMessage } from './workspace-components.js'

export function SkillsPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView>({ installed: [], bindings: [], sources: [] })
  const [market, setMarket] = useState<SkillMarketView>({ sources: [], entries: [], errors: [] })
  const [query, setQuery] = useState('')
  const [activeSource, setActiveSource] = useState('market-clawhub')
  const [busy, setBusy] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [actionError, setActionError] = useState<{ kind: 'install' | 'uninstall'; id: string; message: string }>()
  const [addingSource, setAddingSource] = useState(false)
  const [creatingSkill, setCreatingSkill] = useState(false)
  const [editingNetwork, setEditingNetwork] = useState(false)
  const [showAllInstalled, setShowAllInstalled] = useState(false)
  const [network, setNetwork] = useState<SkillMarketNetworkView>({})
  const load = useCallback(async (refresh = false) => {
    try {
      const [nextCatalog, nextMarket, nextNetwork] = await Promise.all([
        api<SkillCatalogView>('/skills'), api<SkillMarketView>(`/skills/market${refresh ? '?refresh=1' : ''}`), api<SkillMarketNetworkView>('/skill-markets/network'),
      ])
      setCatalog(nextCatalog); setMarket(nextMarket); setNetwork(nextNetwork); setError(undefined)
    } catch (reason) { setError(errorMessage(reason)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const installed = new Map(catalog.installed.map(item => [item.id, item]))
  const visibleInstalled = showAllInstalled ? catalog.installed : catalog.installed.slice(0, 4)
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return market.entries.filter(item => (item.sourceId === activeSource) && (!normalized || `${item.name} ${item.description} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)))
  }, [activeSource, market.entries, query])
  const sources = [{ id: 'builtin', name: '内置精选' }, ...market.sources.map(source => ({ id: source.id, name: source.name }))]
  const sourceCounts = useMemo(() => market.entries.reduce((counts, entry) => {
    counts.set(entry.sourceId, (counts.get(entry.sourceId) ?? 0) + 1)
    return counts
  }, new Map<string, number>()), [market.entries])
  const install = async (entry: MarketSkillView): Promise<void> => {
    setBusy(entry.id); setActionError(undefined)
    try {
      await api('/skills/market/install', { method: 'POST', body: JSON.stringify({ sourceId: entry.sourceId, entryId: entry.id }) })
      await load()
    } catch (reason) { setActionError({ kind: 'install', id: entry.id, message: errorMessage(reason) }) } finally { setBusy(undefined) }
  }
  const uninstall = async (id: string): Promise<void> => {
    setBusy(id); setActionError(undefined)
    try { await api(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() }
    catch (reason) { setActionError({ kind: 'uninstall', id, message: errorMessage(reason) }) } finally { setBusy(undefined) }
  }
  return <div className="dsh-partner-feature-page">
    <WorkspaceHero eyebrow="Capability catalog" title="Skill 市场" detail="集中安装和维护工作能力；安装后，再为需要它的伙伴单独启用。" actions={<button type="button" disabled={loading} onClick={() => { void load(true) }}><IconRefreshOutline16 size={15} />{loading ? '同步中…' : '刷新市场'}</button>} />
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {creatingSkill && <WorkspaceDialog title="新建 Skill" detail="创建一个可复用的工作流程，并明确执行上下文、工具边界和验收指令。" close={() => setCreatingSkill(false)} width="wide"><NewSkillForm existingIds={catalog.installed.map(skill => skill.id)} close={() => setCreatingSkill(false)} changed={load} /></WorkspaceDialog>}
    {editingNetwork && <WorkspaceDialog title="市场网络设置" detail="配置 Skill 索引和安装包下载共用的 HTTP 代理，并在保存前测试连通性。" close={() => setEditingNetwork(false)}><NetworkSettingsForm value={network} close={() => setEditingNetwork(false)} changed={async next => { setNetwork(next); await load(true) }} /></WorkspaceDialog>}
    {addingSource && <WorkspaceDialog title="添加市场来源" detail="接入团队或个人维护的 Skill 索引。自定义来源默认按不可信来源隔离执行。" close={() => setAddingSource(false)}><MarketSourceForm close={() => setAddingSource(false)} changed={() => load(true)} /></WorkspaceDialog>}
    <WorkspaceBlock title="已安装" detail={`${catalog.installed.length} 个可供伙伴使用`} actions={<button type="button" onClick={() => setCreatingSkill(true)}><IconPlusOutline16 size={14} />新建 Skill</button>}>
      {loading ? <CollectionSkeleton rows={2} /> : catalog.installed.length === 0 ? <CollectionEmpty title="还没有安装 Skill" detail="可以创建自己的 Skill，或从下方市场选择。" action={<button type="button" onClick={() => setCreatingSkill(true)}><IconPlusOutline16 size={14} />新建第一个 Skill</button>} /> : <><div className="dsh-partner-skill-installed is-market">{visibleInstalled.map(skill => <article key={skill.id}>
        <span className="dsh-partner-skill-mark"><IconCheckOutline16 size={16} /></span><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.version} · {skill.executionContext === 'fork' ? '临时会话' : '当前会话'} · {skill.source}</small></span>
        <button type="button" className="is-icon" disabled={busy === skill.id} aria-label={`卸载 ${skill.displayName}`} onClick={() => { void uninstall(skill.id) }}><IconTrashOutline16 size={15} /></button>
        {actionError?.kind === 'uninstall' && actionError.id === skill.id && <p className="dsh-partner-skill-action-error" role="alert">卸载失败：{actionError.message}</p>}
      </article>)}</div>{catalog.installed.length > 4 && <button type="button" className="dsh-partner-skill-disclosure" aria-expanded={showAllInstalled} onClick={() => setShowAllInstalled(value => !value)}>{showAllInstalled ? '收起已安装 Skill' : `查看全部 ${catalog.installed.length} 个已安装 Skill`}</button>}</>}
    </WorkspaceBlock>
    <WorkspaceBlock title="市场目录" detail="内置 ClawHub、LoopHub、SkillHub，与 nomifun 当前 Skill 榜单一致" actions={<><button type="button" onClick={() => setEditingNetwork(true)}>代理设置{network.proxyUrl ? ' · 已启用' : ''}</button><button type="button" onClick={() => setAddingSource(true)}><IconPlusOutline16 size={14} />自定义源</button></>}>
      <div className="dsh-partner-market-toolbar">
        <SkillSearch value={query} change={setQuery} count={visible.length} label="搜索 Skill 市场" placeholder="搜索名称、说明或标签" loading={loading} />
        <nav className="dsh-partner-market-sources" aria-label="Skill 市场来源">{sources.map(source => <button type="button" key={source.id} className={activeSource === source.id ? 'is-active' : ''} aria-pressed={activeSource === source.id} onClick={() => setActiveSource(source.id)}><span>{source.name}</span><small>{sourceCounts.get(source.id) ?? 0}</small></button>)}</nav>
      </div>
      {market.errors.some(item => item.sourceId === activeSource) && <p className="dsh-partner-inline-warning">{market.errors.filter(item => item.sourceId === activeSource).map(item => item.error).join('；')}</p>}
      {loading ? <CollectionSkeleton rows={4} /> : <div className="dsh-partner-market-grid">{visible.map(entry => {
        const current = installed.get(entry.id)
        const cardError = actionError?.kind === 'install' && actionError.id === entry.id ? actionError.message : undefined
        const errorId = cardError ? `dsh-partner-skill-error-${entry.id}` : undefined
        return <article key={`${entry.sourceId}:${entry.id}`}><span><small>{entry.tags.slice(0, 3).join(' · ') || 'SKILL'}</small><strong>{entry.name}</strong><p>{entry.description}</p></span>{cardError && <p id={errorId} className="dsh-partner-market-card-error" role="alert">安装失败：{cardError}</p>}<footer><small>v{entry.version}</small>{current ? <button type="button" disabled><IconCheckOutline16 size={14} />已安装</button> : <button type="button" disabled={busy === entry.id} aria-describedby={errorId} onClick={() => { void install(entry) }}>{busy === entry.id ? '安装中…' : cardError ? '重试安装' : '安装'}</button>}</footer></article>
      })}</div>}
      {!loading && visible.length === 0 && <CollectionEmpty title={query ? '没有匹配的 Skill' : '当前来源暂时不可用'} detail={query ? '换一个关键词，或切换市场来源。' : '刷新市场，或检查代理与来源配置。'} />}
    </WorkspaceBlock>
  </div>
}

export function CompanionSkillSettings({ companionId }: { companionId: string }): JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView>({ installed: [], bindings: [], sources: [] })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [selecting, setSelecting] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const load = useCallback(async () => {
    try { setCatalog(await api<SkillCatalogView>('/skills')); setError(undefined) }
    catch (reason) { setError(errorMessage(reason)) }
  }, [])
  useEffect(() => { void load() }, [load, companionId])
  useEffect(() => { setSelecting(false); setShowAll(false); setQuery(''); setError(undefined) }, [companionId])
  const enabled = useMemo(() => new Set(catalog.bindings.filter(item => item.companionId === companionId && item.enabled).map(item => item.skillId)), [catalog.bindings, companionId])
  const enabledSkills = useMemo(() => catalog.installed.filter(skill => enabled.has(skill.id)), [catalog.installed, enabled])
  const availableSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return catalog.installed.filter(skill => !enabled.has(skill.id) && (!normalized || `${skill.displayName} ${skill.description} ${skill.id}`.toLocaleLowerCase().includes(normalized)))
  }, [catalog.installed, enabled, query])
  const visibleEnabledSkills = showAll ? enabledSkills : enabledSkills.slice(0, 4)
  const visibleAvailableSkills = availableSkills.slice(0, 80)
  const setBinding = async (skillId: string, nextEnabled: boolean): Promise<void> => {
    setBusy(skillId)
    setError(undefined)
    try {
      await api(`/companions/${encodeURIComponent(companionId)}/skills/${encodeURIComponent(skillId)}`, { method: 'PUT', body: JSON.stringify({ enabled: nextEnabled }) })
      await load()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  return <section className="dsh-partner-capability-detail" aria-labelledby="dsh-partner-skill-capability-title">
    <header><span><small>PARTNER SKILLS</small><strong id="dsh-partner-skill-capability-title">当前伙伴的 Skill</strong></span><div className="dsh-partner-capability-actions"><em>{enabledSkills.length} 个启用</em>{catalog.installed.length > 0 && <button type="button" aria-expanded={selecting} onClick={() => setSelecting(value => !value)}><IconPlusOutline16 size={14} />添加 Skill</button>}</div></header>
    {selecting && <div className="dsh-partner-skill-picker" aria-label="添加 Skill">
      <SkillSearch value={query} change={setQuery} count={availableSkills.length} label="搜索可添加的 Skill" placeholder="搜索名称、说明或标识" autoFocus compact />
      <div className="dsh-partner-skill-picker-list">{visibleAvailableSkills.map(skill => <article key={skill.id}><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.executionContext === 'fork' ? '隔离临时会话执行' : '可信当前会话执行'}</small></span><button type="button" disabled={busy === skill.id} onClick={() => { void setBinding(skill.id, true) }}>{busy === skill.id ? '添加中…' : '添加'}</button></article>)}{availableSkills.length === 0 && <p className="dsh-partner-skill-picker-empty">{query ? '没有匹配的未启用 Skill。' : '所有已安装 Skill 都已启用。'}</p>}</div>
      {availableSkills.length > visibleAvailableSkills.length && <small className="dsh-partner-skill-picker-limit">还有 {availableSkills.length - visibleAvailableSkills.length} 个结果，请输入关键词继续筛选。</small>}
    </div>}
    {catalog.installed.length === 0 ? <p className="dsh-partner-feature-empty">尚未安装 Skill，请先从左侧的 Skill 市场安装。</p> : enabledSkills.length === 0 ? <p className="dsh-partner-feature-empty">当前伙伴还没有启用 Skill。点击“添加 Skill”选择需要的能力。</p> : <>
      <div className="dsh-partner-skill-installed is-binding">{visibleEnabledSkills.map(skill => <article key={skill.id}>
        <span className="dsh-partner-skill-mark"><IconCheckOutline16 size={16} /></span><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.executionContext === 'fork' ? '隔离临时会话执行' : '可信当前会话执行'}</small></span>
        <button type="button" className="dsh-partner-skill-binding-action" disabled={busy === skill.id} aria-label={`从当前伙伴停用 ${skill.displayName}`} onClick={() => { void setBinding(skill.id, false) }}>{busy === skill.id ? '处理中…' : '停用'}</button>
      </article>)}</div>
      {enabledSkills.length > 4 && <button type="button" className="dsh-partner-skill-disclosure" aria-expanded={showAll} onClick={() => setShowAll(value => !value)}>{showAll ? '收起 Skill' : `查看全部 ${enabledSkills.length} 个 Skill`}</button>}
    </>}
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
  </section>
}

function SkillSearch({ value, change, count, label, placeholder, loading = false, autoFocus = false, compact = false }: {
  value: string
  change(value: string): void
  count: number
  label: string
  placeholder: string
  loading?: boolean
  autoFocus?: boolean
  compact?: boolean
}): JSX.Element {
  return <div className={`dsh-partner-skill-search${compact ? ' is-compact' : ''}`} role="search" aria-label={label}>
    <span className="dsh-partner-skill-search-icon" aria-hidden="true"><IconSearchOutline16 size={16} /></span>
    <input
      type="search"
      value={value}
      autoFocus={autoFocus}
      aria-label={label}
      placeholder={placeholder}
      onChange={event => change(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape' && value) { event.preventDefault(); change('') } }}
    />
    {value && <button type="button" className="dsh-partner-skill-search-clear" aria-label="清空搜索" title="清空搜索" onClick={() => change('')}><IconCloseOutline16 size={14} /></button>}
    <span className="dsh-partner-skill-search-count" aria-live="polite">{loading ? '同步中' : `${count} 项`}</span>
  </div>
}

function NewSkillForm({ existingIds, close, changed }: { existingIds: string[]; close(): void; changed(): Promise<void> | void }): JSX.Element {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    const id = String(data.get('id') ?? '').trim().toLocaleLowerCase()
    if (existingIds.includes(id)) { setError('这个 Skill 标识已经存在，请换一个标识。'); return }
    setBusy(true); setError(undefined)
    try {
      const document = skillDocument({
        id,
        displayName: String(data.get('displayName') ?? ''),
        description: String(data.get('description') ?? ''),
        context: String(data.get('context') ?? 'fork'),
        allowedTools: String(data.get('allowedTools') ?? ''),
        instructions: String(data.get('instructions') ?? ''),
      })
      await api('/skills/local', { method: 'POST', body: JSON.stringify({ id, document }) })
      await changed(); close()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-skill-form" aria-busy={busy} onSubmit={event => { void submit(event) }}><label><span>Skill 名称</span><input name="displayName" required maxLength={120} autoFocus placeholder="例如：发布说明整理" /></label><label><span>Skill 标识</span><input name="id" required maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}" placeholder="release-notes" /></label><label className="is-wide"><span>一句话说明</span><input name="description" required maxLength={600} placeholder="说明什么时候使用，以及要解决什么问题" /></label><label><span>执行方式</span><select name="context" defaultValue="fork"><option value="fork">隔离临时会话</option><option value="inline">可信当前会话</option></select></label><label><span>允许的工具</span><input name="allowedTools" maxLength={1000} placeholder="多个工具用逗号分隔，可留空" /></label><label className="is-wide"><span>Skill 指令</span><textarea name="instructions" required maxLength={500000} rows={8} placeholder="写清工作步骤、边界、输出格式和验收条件" /></label>{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy}><IconPlusOutline16 size={14} />{busy ? '创建中…' : '创建 Skill'}</button></footer></form>
}

function NetworkSettingsForm({ value, close, changed }: { value: SkillMarketNetworkView; close(): void; changed(value: SkillMarketNetworkView): Promise<void> | void }): JSX.Element {
  const [proxyUrl, setProxyUrl] = useState(value.proxyUrl ?? '')
  const [busy, setBusy] = useState<'save' | 'test'>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const test = async (): Promise<void> => {
    setBusy('test'); setError(undefined); setStatus(undefined)
    try {
      const result = await api<SkillMarketNetworkTestView>('/skill-markets/network', { method: 'POST', body: JSON.stringify({ proxyUrl: proxyUrl.trim() }) })
      setStatus(`连接正常 · ${result.sourceCount} 个来源 · ${result.entryCount} 个 Skill · ${result.latencyMs} ms`)
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy('save'); setError(undefined)
    try {
      const next = await api<SkillMarketNetworkView>('/skill-markets/network', { method: 'PUT', body: JSON.stringify({ proxyUrl: proxyUrl.trim() }) })
      await changed(next); close()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(undefined) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-network-form" aria-busy={busy !== undefined} onSubmit={event => { void save(event) }}><label className="is-wide"><span>HTTP 代理</span><input type="url" autoFocus value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder="http://host.docker.internal:7893" /><small>留空为直连；市场列表和安装包下载共用这个代理。</small></label>{status && <WorkspaceNotice kind="success">{status}</WorkspaceNotice>}{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={busy !== undefined} onClick={() => { void test() }}>{busy === 'test' ? '测试中…' : '测试连接'}</button><span className="dsh-partner-form-footer-spacer" /><button type="button" disabled={busy !== undefined} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy !== undefined}>{busy === 'save' ? '保存中…' : '保存设置'}</button></footer></form>
}

function MarketSourceForm({ close, changed }: { close(): void; changed(): Promise<void> | void }): JSX.Element {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    setBusy(true); setError(undefined)
    try {
      await api('/skill-markets', { method: 'POST', body: JSON.stringify({ name: data.get('name'), indexUrl: data.get('indexUrl'), enabled: true, trusted: false }) })
      await changed(); close()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-market-source-form" aria-busy={busy} onSubmit={event => { void submit(event) }}><label><span>来源名称</span><input name="name" required maxLength={100} autoFocus placeholder="团队 Skill 市场" /></label><label><span>索引 URL</span><input name="indexUrl" required type="url" placeholder="https://example.com/skills.json" /></label>{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy}>{busy ? '添加中…' : '添加来源'}</button></footer></form>
}
function skillDocument(value: { id: string; displayName: string; description: string; context: string; allowedTools: string; instructions: string }): string {
  const requestedTools = value.allowedTools.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean)
  const invalidTool = requestedTools.find(item => !/^[a-zA-Z0-9._:-]+$/.test(item))
  if (invalidTool) throw new Error(`工具名称格式不正确：${invalidTool}`)
  const tools = [...new Set(requestedTools)].slice(0, 64)
  return `---\nname: ${value.id}\ndisplay-name: ${skillScalar(value.displayName)}\ndescription: ${skillScalar(value.description)}\nversion: 1.0.0\ncontext: ${value.context === 'inline' ? 'inline' : 'fork'}\nallowed-tools: [${tools.join(', ')}]\n---\n# ${value.displayName.replace(/[\r\n#]+/g, ' ').trim()}\n\n${value.instructions.trim()}\n`
}
function skillScalar(value: string): string { return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim()}"` }
