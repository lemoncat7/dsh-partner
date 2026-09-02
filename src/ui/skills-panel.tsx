import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { IconBrowseOutline16, IconCheckOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type MarketSkillView, type SkillCatalogView, type SkillMarketNetworkTestView, type SkillMarketNetworkView, type SkillMarketView } from '../client-api.js'

export function SkillsPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView>({ installed: [], bindings: [], sources: [] })
  const [market, setMarket] = useState<SkillMarketView>({ sources: [], entries: [], errors: [] })
  const [query, setQuery] = useState('')
  const [activeSource, setActiveSource] = useState('market-clawhub')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [actionError, setActionError] = useState<{ kind: 'install' | 'uninstall'; id: string; message: string }>()
  const [addingSource, setAddingSource] = useState(false)
  const [creatingSkill, setCreatingSkill] = useState(false)
  const [editingNetwork, setEditingNetwork] = useState(false)
  const [network, setNetwork] = useState<SkillMarketNetworkView>({})
  const load = useCallback(async (refresh = false) => {
    try {
      const [nextCatalog, nextMarket, nextNetwork] = await Promise.all([
        api<SkillCatalogView>('/skills'), api<SkillMarketView>(`/skills/market${refresh ? '?refresh=1' : ''}`), api<SkillMarketNetworkView>('/skill-markets/network'),
      ])
      setCatalog(nextCatalog); setMarket(nextMarket); setNetwork(nextNetwork); setError(undefined)
    } catch (reason) { setError(message(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const installed = new Map(catalog.installed.map(item => [item.id, item]))
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return market.entries.filter(item => (item.sourceId === activeSource) && (!normalized || `${item.name} ${item.description} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)))
  }, [activeSource, market.entries, query])
  const sources = [{ id: 'builtin', name: '内置精选' }, ...market.sources.map(source => ({ id: source.id, name: source.name }))]
  const install = async (entry: MarketSkillView): Promise<void> => {
    setBusy(entry.id); setActionError(undefined)
    try {
      await api('/skills/market/install', { method: 'POST', body: JSON.stringify({ sourceId: entry.sourceId, entryId: entry.id }) })
      await load()
    } catch (reason) { setActionError({ kind: 'install', id: entry.id, message: message(reason) }) } finally { setBusy(undefined) }
  }
  const uninstall = async (id: string): Promise<void> => {
    setBusy(id); setActionError(undefined)
    try { await api(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() }
    catch (reason) { setActionError({ kind: 'uninstall', id, message: message(reason) }) } finally { setBusy(undefined) }
  }
  return <div className="dsh-partner-feature-page">
    <header className="dsh-partner-feature-hero"><span><small>CAPABILITY CATALOG</small><h2>Skill 市场</h2><p>这里负责安装和维护 Skill；安装后，再到具体伙伴的“能力”页面选择是否启用。</p></span><button type="button" onClick={() => { void load(true) }}><IconRefreshOutline16 size={15} />刷新市场</button></header>
    {error && <p className="dsh-partner-feature-error" role="alert">{error}</p>}
    <section className="dsh-partner-feature-block">
      <header><span><strong>已安装</strong><small>{catalog.installed.length} 个可供伙伴使用</small></span><button type="button" onClick={() => setCreatingSkill(value => !value)}><IconPlusOutline16 size={14} />新建 Skill</button></header>
      {creatingSkill && <NewSkillForm existingIds={catalog.installed.map(skill => skill.id)} close={() => setCreatingSkill(false)} changed={load} />}
      {catalog.installed.length === 0 ? <Empty text="还没有安装 Skill，可从下方市场选择。" /> : <div className="dsh-partner-skill-installed is-market">{catalog.installed.map(skill => <article key={skill.id}>
        <span className="dsh-partner-skill-mark"><IconCheckOutline16 size={16} /></span><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.version} · {skill.executionContext === 'fork' ? '临时会话' : '当前会话'} · {skill.source}</small></span>
        <button type="button" className="is-icon" disabled={busy === skill.id} aria-label={`卸载 ${skill.displayName}`} onClick={() => { void uninstall(skill.id) }}><IconTrashOutline16 size={15} /></button>
        {actionError?.kind === 'uninstall' && actionError.id === skill.id && <p className="dsh-partner-skill-action-error" role="alert">卸载失败：{actionError.message}</p>}
      </article>)}</div>}
    </section>
    <section className="dsh-partner-feature-block">
      <header><span><strong>Skill 市场</strong><small>内置 ClawHub、LoopHub、SkillHub，与 nomifun 当前 Skill 榜单一致</small></span><div><button type="button" onClick={() => setEditingNetwork(value => !value)}>代理设置{network.proxyUrl ? ' · 已启用' : ''}</button><button type="button" onClick={() => setAddingSource(value => !value)}><IconPlusOutline16 size={14} />自定义源</button></div></header>
      {editingNetwork && <NetworkSettingsForm value={network} close={() => setEditingNetwork(false)} changed={async next => { setNetwork(next); await load(true) }} />}
      {addingSource && <MarketSourceForm close={() => setAddingSource(false)} changed={() => load(true)} />}
      <nav className="dsh-partner-market-sources" aria-label="Skill 市场来源">{sources.map(source => <button type="button" key={source.id} className={activeSource === source.id ? 'is-active' : ''} aria-pressed={activeSource === source.id} onClick={() => setActiveSource(source.id)}>{source.name}<small>{market.entries.filter(entry => entry.sourceId === source.id).length}</small></button>)}</nav>
      <label className="dsh-partner-feature-search"><IconBrowseOutline16 size={16} /><span className="sr-only">搜索 Skill</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、说明或标签" /></label>
      {market.errors.some(item => item.sourceId === activeSource) && <p className="dsh-partner-inline-warning">{market.errors.filter(item => item.sourceId === activeSource).map(item => item.error).join('；')}</p>}
      <div className="dsh-partner-market-grid">{visible.map(entry => {
        const current = installed.get(entry.id)
        const cardError = actionError?.kind === 'install' && actionError.id === entry.id ? actionError.message : undefined
        const errorId = cardError ? `dsh-partner-skill-error-${entry.id}` : undefined
        return <article key={`${entry.sourceId}:${entry.id}`}><span><small>{entry.tags.slice(0, 3).join(' · ') || 'SKILL'}</small><strong>{entry.name}</strong><p>{entry.description}</p></span>{cardError && <p id={errorId} className="dsh-partner-market-card-error" role="alert">安装失败：{cardError}</p>}<footer><small>v{entry.version}</small>{current ? <button type="button" disabled><IconCheckOutline16 size={14} />已安装</button> : <button type="button" disabled={busy === entry.id} aria-describedby={errorId} onClick={() => { void install(entry) }}>{busy === entry.id ? '安装中…' : cardError ? '重试安装' : '安装'}</button>}</footer></article>
      })}</div>
      {visible.length === 0 && <Empty text={query ? '当前来源没有匹配的 Skill。' : '当前来源暂时没有可用 Skill，可刷新后重试。'} />}
    </section>
  </div>
}

export function CompanionSkillSettings({ companionId }: { companionId: string }): JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView>({ installed: [], bindings: [], sources: [] })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try { setCatalog(await api<SkillCatalogView>('/skills')); setError(undefined) }
    catch (reason) { setError(message(reason)) }
  }, [])
  useEffect(() => { void load() }, [load, companionId])
  const enabled = new Set(catalog.bindings.filter(item => item.companionId === companionId && item.enabled).map(item => item.skillId))
  const toggle = async (skillId: string): Promise<void> => {
    setBusy(skillId)
    try {
      await api(`/companions/${encodeURIComponent(companionId)}/skills/${encodeURIComponent(skillId)}`, { method: 'PUT', body: JSON.stringify({ enabled: !enabled.has(skillId) }) })
      await load()
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  return <section className="dsh-partner-capability-detail" aria-labelledby="dsh-partner-skill-capability-title">
    <header><span><small>PARTNER SKILLS</small><strong id="dsh-partner-skill-capability-title">当前伙伴的 Skill</strong></span><em>{enabled.size} 个启用</em></header>
    {catalog.installed.length === 0 ? <p className="dsh-partner-feature-empty">尚未安装 Skill，请先从左侧的 Skill 市场安装。</p> : <div className="dsh-partner-skill-installed">{catalog.installed.map(skill => <article key={skill.id}>
      <span className="dsh-partner-skill-mark"><IconCheckOutline16 size={16} /></span><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.executionContext === 'fork' ? '隔离临时会话执行' : '可信当前会话执行'}</small></span>
      <button type="button" className="dsh-partner-feature-switch" data-on={enabled.has(skill.id)} disabled={busy === skill.id} aria-label={`${enabled.has(skill.id) ? '停用' : '启用'} ${skill.displayName}`} aria-pressed={enabled.has(skill.id)} onClick={() => { void toggle(skill.id) }}><i /></button>
    </article>)}</div>}
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
  </section>
}

function NewSkillForm({ existingIds, close, changed }: { existingIds: string[]; close(): void; changed(): Promise<void> | void }): JSX.Element {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    const id = String(data.get('id') ?? '').trim().toLocaleLowerCase()
    if (existingIds.includes(id)) { setError('这个 Skill 标识已经存在，请换一个标识。'); return }
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
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-skill-form" onSubmit={event => { void submit(event) }}><label><span>Skill 名称</span><input name="displayName" required maxLength={120} autoFocus placeholder="例如：发布说明整理" /></label><label><span>Skill 标识</span><input name="id" required maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,79}" placeholder="release-notes" /></label><label className="is-wide"><span>一句话说明</span><input name="description" required maxLength={600} placeholder="说明什么时候使用，以及要解决什么问题" /></label><label><span>执行方式</span><select name="context" defaultValue="fork"><option value="fork">隔离临时会话</option><option value="inline">可信当前会话</option></select></label><label><span>允许的工具</span><input name="allowedTools" maxLength={1000} placeholder="多个工具用逗号分隔，可留空" /></label><label className="is-wide"><span>Skill 指令</span><textarea name="instructions" required maxLength={500000} rows={8} placeholder="写清工作步骤、边界、输出格式和验收条件" /></label><footer><button type="submit"><IconPlusOutline16 size={14} />创建 Skill</button><button type="button" onClick={close}>取消</button></footer>{error && <p role="alert">{error}</p>}</form>
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
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy('save'); setError(undefined)
    try {
      const next = await api<SkillMarketNetworkView>('/skill-markets/network', { method: 'PUT', body: JSON.stringify({ proxyUrl: proxyUrl.trim() }) })
      await changed(next); close()
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-network-form" onSubmit={event => { void save(event) }}><label className="is-wide"><span>HTTP 代理</span><input type="url" value={proxyUrl} onChange={event => setProxyUrl(event.target.value)} placeholder="http://host.docker.internal:7893" /><small>留空为直连；市场列表和安装包下载共用这个代理。</small></label><footer><button type="button" disabled={busy !== undefined} onClick={() => { void test() }}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="submit" disabled={busy !== undefined}>{busy === 'save' ? '保存中…' : '保存设置'}</button><button type="button" disabled={busy !== undefined} onClick={close}>取消</button></footer>{status && <p className="is-success" role="status">{status}</p>}{error && <p role="alert">{error}</p>}</form>
}

function MarketSourceForm({ close, changed }: { close(): void; changed(): Promise<void> | void }): JSX.Element {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      await api('/skill-markets', { method: 'POST', body: JSON.stringify({ name: data.get('name'), indexUrl: data.get('indexUrl'), enabled: true, trusted: false }) })
      await changed(); close()
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-feature-form dsh-partner-market-source-form" onSubmit={event => { void submit(event) }}><label><span>来源名称</span><input name="name" required maxLength={100} placeholder="团队 Skill 市场" /></label><label><span>索引 URL</span><input name="indexUrl" required type="url" placeholder="https://example.com/skills.json" /></label><footer><button type="submit">添加来源</button><button type="button" onClick={close}>取消</button></footer>{error && <p role="alert">{error}</p>}</form>
}
function Empty({ text }: { text: string }): JSX.Element { return <p className="dsh-partner-feature-empty">{text}</p> }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function skillDocument(value: { id: string; displayName: string; description: string; context: string; allowedTools: string; instructions: string }): string {
  const requestedTools = value.allowedTools.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean)
  const invalidTool = requestedTools.find(item => !/^[a-zA-Z0-9._:-]+$/.test(item))
  if (invalidTool) throw new Error(`工具名称格式不正确：${invalidTool}`)
  const tools = [...new Set(requestedTools)].slice(0, 64)
  return `---\nname: ${value.id}\ndisplay-name: ${skillScalar(value.displayName)}\ndescription: ${skillScalar(value.description)}\nversion: 1.0.0\ncontext: ${value.context === 'inline' ? 'inline' : 'fork'}\nallowed-tools: [${tools.join(', ')}]\n---\n# ${value.displayName.replace(/[\r\n#]+/g, ' ').trim()}\n\n${value.instructions.trim()}\n`
}
function skillScalar(value: string): string { return `"${value.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim()}"` }
