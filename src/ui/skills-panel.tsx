import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { IconBrowseOutline16, IconCheckOutline16, IconPlusOutline16, IconRefreshOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type MarketSkillView, type SkillCatalogView, type SkillMarketView } from '../client-api.js'

export function SkillsPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<SkillCatalogView>({ installed: [], bindings: [], sources: [] })
  const [market, setMarket] = useState<SkillMarketView>({ sources: [], entries: [], errors: [] })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [addingSource, setAddingSource] = useState(false)
  const load = useCallback(async (refresh = false) => {
    try {
      const [nextCatalog, nextMarket] = await Promise.all([
        api<SkillCatalogView>('/skills'), api<SkillMarketView>(`/skills/market${refresh ? '?refresh=1' : ''}`),
      ])
      setCatalog(nextCatalog); setMarket(nextMarket); setError(undefined)
    } catch (reason) { setError(message(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const installed = new Map(catalog.installed.map(item => [item.id, item]))
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return market.entries.filter(item => !normalized || `${item.name} ${item.description} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(normalized))
  }, [market.entries, query])
  const install = async (entry: MarketSkillView): Promise<void> => {
    setBusy(entry.id)
    try {
      await api('/skills/market/install', { method: 'POST', body: JSON.stringify({ sourceId: entry.sourceId, entryId: entry.id }) })
      await load()
    } catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  const uninstall = async (id: string): Promise<void> => {
    setBusy(id)
    try { await api(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() }
    catch (reason) { setError(message(reason)) } finally { setBusy(undefined) }
  }
  return <div className="dsh-partner-feature-page">
    <header className="dsh-partner-feature-hero"><span><small>CAPABILITY CATALOG</small><h2>Skill 市场</h2><p>这里负责安装和维护 Skill；安装后，再到具体伙伴的“能力”页面选择是否启用。</p></span><button type="button" onClick={() => { void load(true) }}><IconRefreshOutline16 size={15} />刷新市场</button></header>
    <section className="dsh-partner-feature-block">
      <header><span><strong>已安装</strong><small>{catalog.installed.length} 个可供伙伴使用</small></span></header>
      {catalog.installed.length === 0 ? <Empty text="还没有安装 Skill，可从下方市场选择。" /> : <div className="dsh-partner-skill-installed is-market">{catalog.installed.map(skill => <article key={skill.id}>
        <span className="dsh-partner-skill-mark"><IconCheckOutline16 size={16} /></span><span><strong>{skill.displayName}</strong><p>{skill.description}</p><small>{skill.version} · {skill.executionContext === 'fork' ? '临时会话' : '当前会话'} · {skill.source}</small></span>
        <button type="button" className="is-icon" disabled={busy === skill.id} aria-label={`卸载 ${skill.displayName}`} onClick={() => { void uninstall(skill.id) }}><IconTrashOutline16 size={15} /></button>
      </article>)}</div>}
    </section>
    <section className="dsh-partner-feature-block">
      <header><span><strong>Skill 市场</strong><small>内置精选 + 可扩展市场源</small></span><button type="button" onClick={() => setAddingSource(value => !value)}><IconPlusOutline16 size={14} />市场源</button></header>
      {addingSource && <MarketSourceForm close={() => setAddingSource(false)} changed={() => load(true)} />}
      <label className="dsh-partner-feature-search"><IconBrowseOutline16 size={16} /><span className="sr-only">搜索 Skill</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、说明或标签" /></label>
      {market.errors.length > 0 && <p className="dsh-partner-inline-warning">{market.errors.map(item => item.error).join('；')}</p>}
      <div className="dsh-partner-market-grid">{visible.map(entry => {
        const current = installed.get(entry.id)
        return <article key={`${entry.sourceId}:${entry.id}`}><span><small>{entry.tags.slice(0, 3).join(' · ') || 'SKILL'}</small><strong>{entry.name}</strong><p>{entry.description}</p></span><footer><small>v{entry.version}</small>{current ? <button type="button" disabled><IconCheckOutline16 size={14} />已安装</button> : <button type="button" disabled={busy === entry.id} onClick={() => { void install(entry) }}>{busy === entry.id ? '安装中…' : '安装'}</button>}</footer></article>
      })}</div>
      {visible.length === 0 && <Empty text={query ? '没有匹配的 Skill。' : '市场暂时没有可用 Skill，可添加兼容的 JSON 索引源。'} />}
    </section>
    {error && <p className="dsh-partner-error" role="alert">{error}</p>}
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

function MarketSourceForm({ close, changed }: { close(): void; changed(): Promise<void> | void }): JSX.Element {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      await api('/skill-markets', { method: 'POST', body: JSON.stringify({ name: data.get('name'), indexUrl: data.get('indexUrl'), enabled: true, trusted: false }) })
      await changed(); close()
    } catch (reason) { setError(message(reason)) }
  }
  return <form className="dsh-partner-inline-form" onSubmit={event => { void submit(event) }}><label><span>名称</span><input name="name" required maxLength={100} placeholder="团队 Skill 市场" /></label><label><span>索引 URL</span><input name="indexUrl" required type="url" placeholder="https://example.com/skills.json" /></label><button type="submit">添加</button><button type="button" onClick={close}>取消</button>{error && <p role="alert">{error}</p>}</form>
}
function Empty({ text }: { text: string }): JSX.Element { return <p className="dsh-partner-feature-empty">{text}</p> }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
