import { useCallback, useEffect, useState } from 'react'
import { IconPlusOutline16, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from '../client-api.js'
import type { McpCatalog, McpServerView } from '../mcp/domain.js'
import { CollectionEmpty, CollectionSkeleton, WorkspaceBlock, WorkspaceDialog, WorkspaceHero, WorkspaceNotice, errorMessage } from './workspace-components.js'
import { FormField } from './partner-components.js'
import { McpEditor } from './mcp-editor.js'

export function McpPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<McpCatalog>({ servers: [], bindings: [] })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<McpServerView | 'new' | 'import'>()
  const [deleting, setDeleting] = useState<McpServerView>()
  const [details, setDetails] = useState<McpServerView>()
  const load = useCallback(async () => {
    try { setCatalog(await api<McpCatalog>('/mcp')); setError('') }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const action = async (server: McpServerView, kind: 'refresh' | 'toggle' | 'delete') => {
    setBusy(server.id); setError(''); setNotice('')
    try {
      const next = await api<McpCatalog>(`/mcp/${server.id}${kind === 'refresh' ? '/refresh' : ''}`, {
        method: kind === 'refresh' ? 'POST' : kind === 'delete' ? 'DELETE' : 'PUT',
        ...(kind === 'toggle' ? { body: JSON.stringify({ name: server.name, enabled: !server.enabled }) } : {}),
      })
      setCatalog(next); setDeleting(undefined)
      setNotice(kind === 'refresh' ? '连接成功，工具目录已刷新。已授权伙伴将在下一轮对话使用最新工具。' : kind === 'delete' ? 'MCP 服务与关联授权已删除。' : '状态已保存，下一轮生效；停用后立即阻止新的调用。')
    } catch (reason) { setError(errorMessage(reason)); if (kind === 'refresh') { try { setCatalog(await api<McpCatalog>('/mcp')) } catch { /* retain list on network failure */ } } }
    finally { setBusy('') }
  }
  const visible = catalog.servers.filter(s => s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className="dsh-partner-feature-page">
    <WorkspaceHero eyebrow="Capability catalog" title="MCP 服务" detail="集中管理外部工具，再在伙伴能力中单独授权。配置与工具目录的更新在下一轮对话生效。" actions={<button type="button" disabled={loading || !!busy} onClick={() => { void load() }}><IconRefreshOutline16 size={15} />刷新列表</button>} />
    {error && !deleting && <WorkspaceNotice>{error}</WorkspaceNotice>}{notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    <WorkspaceBlock title="已配置服务" detail={`${catalog.servers.length} 个服务 · 安装不等于授权`} actions={<><button type="button" onClick={() => setEditor('import')}>导入 JSON</button><button type="button" onClick={() => setEditor('new')}><IconPlusOutline16 size={14} />新增 MCP</button></>}>
      <FormField label="搜索服务"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="按服务名称搜索" /></FormField>
      {loading ? <CollectionSkeleton rows={2} /> : !visible.length ? <CollectionEmpty title={query ? '没有匹配的服务' : '还没有 MCP 服务'} detail="支持 Streamable HTTP 和 stdio；可直接导入 mcpServers JSON。" /> : <div className="dsh-partner-market-grid">{visible.map(server => <article key={server.id}>
        <span><small>{server.transport === 'stdio' ? '本机命令 · STDIO' : '远程服务 · HTTP'} · {server.enabled ? '已启用' : '已停用'}</small><strong>{server.name}</strong><p>{server.tools.length} 个工具 · {catalog.bindings.filter(b => b.serverId === server.id).length} 个伙伴获授权</p><small>{server.refreshedAt ? `上次刷新 ${new Date(server.refreshedAt).toLocaleString()}` : '尚未测试连接，请刷新工具'}</small></span>
        {server.error && <p className="dsh-partner-inline-error" role="alert">{server.error}</p>}
        <footer className="dsh-partner-mcp-actions"><button type="button" disabled={!!busy} onClick={() => { void action(server, 'refresh') }}>{busy === server.id ? '处理中…' : '连接 / 刷新工具'}</button><button type="button" onClick={() => setDetails(server)}>工具列表</button><button type="button" disabled={!!busy} onClick={() => setEditor(server)}>编辑</button><button type="button" disabled={!!busy} onClick={() => { void action(server, 'toggle') }}>{server.enabled ? '停用' : '启用'}</button><button type="button" disabled={!!busy} onClick={() => { setError(''); setDeleting(server) }}>删除</button></footer>
      </article>)}</div>}
    </WorkspaceBlock>
    {editor && <McpEditor value={editor} close={() => setEditor(undefined)} saved={next => { setCatalog(next); setNotice('配置已保存。请连接 / 刷新工具，然后在伙伴能力中授权。'); setEditor(undefined) }} />}
    {details && <WorkspaceDialog title={`${details.name} · 工具列表`} detail="刷新工具会重新获取名称、说明和参数；不执行任何业务工具。" close={() => setDetails(undefined)}>
      {!details.tools.length ? <CollectionEmpty title="暂无工具" detail="请先连接 / 刷新工具。" /> : <div className="dsh-partner-mcp-tool-list">{details.tools.map(tool => <details key={tool.name}><summary>{tool.name}</summary><p>{tool.description || '服务未提供说明'}</p><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</div>}
    </WorkspaceDialog>}
    {deleting && <WorkspaceDialog title="删除 MCP 服务" detail={`确认删除“${deleting.name}”？关联授权也会移除，不会删除远程服务的数据。`} close={() => { if (!busy) setDeleting(undefined) }}>
      <div className="dsh-partner-feature-form">{error && <WorkspaceNotice>{error}</WorkspaceNotice>}<footer><button type="button" disabled={!!busy} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className="is-primary" disabled={!!busy} onClick={() => { void action(deleting, 'delete') }}>{busy ? '删除中…' : '确认删除'}</button></footer></div>
    </WorkspaceDialog>}
  </div>
}
