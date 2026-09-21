import { useCallback, useEffect, useState } from 'react'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from '../client-api.js'
import type { McpCatalog } from '../mcp/domain.js'
import { CollectionEmpty, WorkspaceBlock, WorkspaceDialog, WorkspaceNotice, errorMessage } from './workspace-components.js'
import { FormField } from './partner-components.js'

export function CompanionMcpSettings({ companionId, embedded = false, onBusyChange }: { companionId: string; embedded?: boolean; onBusyChange?(busy: boolean): void }): JSX.Element {
  const [catalog, setCatalog] = useState<McpCatalog>({ servers: [], bindings: [] })
  const [selecting, setSelecting] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    try { setCatalog(await api<McpCatalog>('/mcp')); setError('') }
    catch (reason) { setError(errorMessage(reason)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const ids = new Set(catalog.bindings.filter(b => b.companionId === companionId).map(b => b.serverId))
  const authorized = catalog.servers.filter(s => ids.has(s.id))
  const toggle = async (serverId: string, enabled: boolean) => {
    if (busy) return
    onBusyChange?.(true)
    setBusy(true); setError(''); setNotice('')
    try {
      setCatalog(await api<McpCatalog>('/mcp/bindings', { method: 'POST', body: JSON.stringify({ companionId, serverId, enabled }) }))
      setNotice(enabled ? '已授权，下一轮对话生效，无需新建会话。' : '授权已移除，立即阻止新的调用，下一轮移除工具列表。')
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setBusy(false); onBusyChange?.(false) }
  }
  const feedback = <>{error && <WorkspaceNotice>{error}</WorkspaceNotice>}{notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}</>
  const picker = <>
    {feedback}<FormField label="搜索服务"><input value={query} onChange={e => setQuery(e.target.value)} /></FormField>
    <div className="dsh-partner-skill-installed dsh-partner-mcp-bindings">{catalog.servers.filter(s => s.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(server => <article key={server.id}><span><strong>{server.name}</strong><p>{server.tools.length} 个工具 · {ids.has(server.id) ? '已授权' : '未授权'}{!server.enabled && ' · 已停用'}</p></span><button type="button" aria-pressed={ids.has(server.id)} disabled={busy} onClick={() => { void toggle(server.id, !ids.has(server.id)) }}>{ids.has(server.id) ? '移除授权' : '授权'}</button></article>)}</div>
    {!catalog.servers.length && <CollectionEmpty title="没有可用服务" detail="先前往 MCP 服务页新增或导入配置。" />}
  </>
  if (embedded) return <section className="dsh-partner-capability-picker"><p className="dsh-partner-inline-note">授权服务即允许调用该服务的工具。凭据不会提供给伙伴，修改于下一轮生效。</p>{picker}</section>
  return <WorkspaceBlock title="已授权 MCP" detail="只注入选中的服务；新增或修改工具后，在 MCP 服务页刷新工具即可于下一轮生效。" actions={<button type="button" onClick={() => { setSelecting(true); void load() }}><IconPlusOutline16 size={14} />选择 MCP</button>}>
    {!selecting && feedback}
    {!authorized.length ? <CollectionEmpty title="尚未授权 MCP 服务" detail="先在 MCP 服务页添加配置，再在此选择。" /> : <div className="dsh-partner-skill-installed dsh-partner-mcp-bindings">{(showAll ? authorized : authorized.slice(0, 4)).map(server => <article key={server.id}><span><strong>{server.name}</strong><p>{server.tools.length} 个工具 · {server.enabled ? '已启用' : '服务已停用'}</p></span><button type="button" disabled={busy} onClick={() => { void toggle(server.id, false) }}>移除授权</button></article>)}</div>}
    {authorized.length > 4 && <button type="button" className="dsh-partner-skill-disclosure" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>{showAll ? '收起' : `查看全部 ${authorized.length} 个 MCP`}</button>}
    {selecting && <WorkspaceDialog title="选择 MCP 服务" detail="授权服务即允许调用该服务刷新后公布的所有工具。凭据不会提供给伙伴。" close={() => { if (!busy) setSelecting(false) }}>
      {picker}
    </WorkspaceDialog>}
  </WorkspaceBlock>
}
