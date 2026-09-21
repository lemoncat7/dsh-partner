import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../client-api.js'
import type { McpCatalog, McpEditView, McpServerView } from '../mcp/domain.js'
import { WorkspaceDialog, WorkspaceNotice, errorMessage } from './workspace-components.js'

export function McpEditor({ value, close, saved }: { value: McpServerView | 'new' | 'import'; close(): void; saved(catalog: McpCatalog): void }): JSX.Element {
  const existing = typeof value === 'object' ? value : undefined
  const importing = value === 'import'
  const [name, setName] = useState(existing?.name ?? '')
  const [json, setJson] = useState('')
  const [original, setOriginal] = useState('')
  const [revision, setRevision] = useState<number>()
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(!!existing)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const field = useId()
  const load = async (reveal: boolean) => {
    if (!existing) return
    setLoading(true); setError('')
    try {
      const next = await api<McpEditView>(`/mcp/${existing.id}/config${reveal ? '?reveal=1' : ''}`)
      if (!mounted.current) return
      const text = JSON.stringify(next.config, null, 2)
      if (revision === undefined) setName(next.name)
      setJson(text); setOriginal(text); setRevision(next.revision); setRevealed(reveal)
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)) }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => { mounted.current = true; void load(false); return () => { mounted.current = false } }, [])
  const hint = importing
    ? '粘贴包含 mcpServers 的完整配置，服务名称取自其中的键名；可一次导入多个服务。单个 url / command 对象请用「新增 MCP」。'
    : existing
      ? '已回填当前配置。{{DSH_MCP_SAVED:…}} 表示已保存的值，保持原样即可保留；填写新值可替换，删除字段则移除。认证和命令参数默认隐藏，可点「显示完整配置」。'
      : '这里填写一个服务的配置：HTTP 包含 url，stdio 包含 command 和 args。也支持直接粘贴仅含一个服务的完整 mcpServers 配置；多个服务请用「导入 JSON」。'
  const example = JSON.stringify(importing ? { mcpServers: { docmost: { type: 'http', url: 'http://docmost:3000/mcp', headers: { Authorization: 'Bearer YOUR_TOKEN' } } } } : { type: 'http', url: 'http://docmost:3000/mcp', headers: { Authorization: 'Bearer YOUR_TOKEN' } }, null, 2)
  const stdioExample = JSON.stringify(importing ? { mcpServers: { example: { command: 'npx', args: ['-y', 'your-mcp-package'] } } } : { command: 'npx', args: ['-y', 'your-mcp-package'] }, null, 2)
  const submit = async () => {
    if (busy || loading || (existing && revision === undefined)) return
    setBusy(true); setError('')
    try {
      let parsed: unknown
      if (json.trim()) {
        try { parsed = JSON.parse(json) } catch { throw Error('JSON 格式不正确，请检查双引号、逗号和括号；可展开下方格式示例对照。') }
      }
      if (parsed === undefined) throw Error(existing ? '配置不能为空。如需保留已有值，请保留原配置和占位符。' : '请填写 JSON 配置，可参考下方格式示例。')
      const next = await api<McpCatalog>(importing ? '/mcp/import' : existing ? `/mcp/${existing.id}` : '/mcp', { method: existing ? 'PUT' : 'POST', body: JSON.stringify(importing ? parsed : { name, config: parsed, ...(existing ? { expectedRevision: revision } : {}) }) })
      if (mounted.current) saved(next)
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <WorkspaceDialog title={importing ? '导入 MCP 配置' : existing ? '编辑 MCP 服务' : '新增 MCP 服务'} detail={importing ? '导入完整的客户端配置，可包含一个或多个服务。' : existing ? '修改当前服务配置，不需要重新填写已保存的凭据。' : '手动添加一个服务，名称仅用于页面展示。'} close={() => { if (!busy) close() }}>
    <form className="dsh-partner-feature-form" onSubmit={e => { e.preventDefault(); void submit() }}>
      {!importing && <label className="is-wide"><span>服务名称</span><input aria-label="服务名称" required maxLength={80} value={name} disabled={busy || loading} placeholder="例如：Docmost 文档" onChange={e => setName(e.target.value)} /><small>伙伴界面中的显示名称，不是服务地址，也不是 JSON 字段。</small></label>}
      <label className="is-wide" htmlFor={field}><span>{importing ? '完整配置 JSON（包含 mcpServers）' : '连接配置 JSON（单个服务）'}</span><small id={`${field}-hint`}>{hint}</small></label>
      <textarea className="is-wide" id={field} rows={10} value={json} disabled={busy || loading || (!!existing && revision === undefined)} spellCheck={false} autoComplete="off" aria-describedby={`${field}-hint${error ? ` ${field}-error` : ''}`} aria-invalid={!!error} onChange={e => setJson(e.target.value)} placeholder={loading ? '正在读取当前配置…' : example} />
      {existing && <p className="dsh-partner-form-help is-wide"><button type="button" disabled={busy || loading || (revision !== undefined && json !== original)} onClick={() => { void load(revision === undefined ? false : !revealed) }}>{loading ? '正在读取…' : revision === undefined ? '重试读取配置' : revealed ? '隐藏敏感值' : '显示完整配置'}</button>{json !== original && ' 配置已修改，保存后可重新切换显示方式。'}</p>}
      <details className="dsh-partner-mcp-examples is-wide"><summary>查看格式示例（不会覆盖已填写内容）</summary><small>HTTP 服务</small><pre>{example}</pre><small>本机命令 · stdio</small><pre>{stdioExample}</pre></details>
      <p className="dsh-partner-form-help is-wide">stdio 在 DSH 所在机器或容器中执行命令，请只添加可信服务。配置保存后，点击「连接 / 刷新工具」，再在伙伴能力中授权。</p>
      {error && <div className="is-wide" id={`${field}-error`}><WorkspaceNotice>{error}</WorkspaceNotice></div>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy || loading || (!!existing && revision === undefined)} aria-busy={busy}>{busy ? '保存中…' : importing ? '导入配置' : '保存配置'}</button></footer>
    </form>
  </WorkspaceDialog>
}
