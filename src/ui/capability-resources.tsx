import { useEffect, useState, type ReactNode } from 'react'
import { api, type Capability, type CompanionAccessView, type SkillCatalogView } from '../client-api.js'
import type { McpCatalog } from '../mcp/domain.js'
import { CompanionSkillSettings } from './skills-panel.js'
import { CompanionMcpSettings } from './mcp-capabilities.js'
import { CompanionAccessPanel } from './companion-access-panel.js'
import { WorkspaceDialog } from './workspace-components.js'

type Resource = 'skills' | 'access' | 'mcp'
const titles = { skills: 'Skill', access: '可访问伙伴', mcp: 'MCP 服务' }

/** Compact entry points only; detailed lists mount on demand inside one shared dialog. */
export function CapabilityResources({ companionId, capabilities, disabled, children }: { companionId: string; capabilities: Capability[]; disabled: boolean; children(manage: (resource: Resource) => ReactNode): ReactNode }): JSX.Element {
  const [opened, setOpened] = useState<Resource>()
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [counts, setCounts] = useState<Partial<Record<Resource, number>>>({})
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setFailed(false)
    const requests: Array<[Resource, Promise<number>]> = [
      ['access', api<CompanionAccessView>(`/companions/${encodeURIComponent(companionId)}/access`).then(v => v.targetIds.length)],
    ]
    if (capabilities.includes('skills')) requests.push(['skills', api<SkillCatalogView>('/skills').then(v => v.installed.filter(s => v.bindings.some(b => b.companionId === companionId && b.skillId === s.id && b.enabled)).length)])
    if (capabilities.includes('mcp')) requests.push(['mcp', api<McpCatalog>('/mcp').then(v => v.servers.filter(s => v.bindings.some(b => b.companionId === companionId && b.serverId === s.id)).length)])
    for (const [key, request] of requests) void request.then(count => { if (live) setCounts(v => ({ ...v, [key]: count })) }).catch(() => { if (live) { setCounts(v => ({ ...v, [key]: undefined })); setFailed(true) } })
    return () => { live = false }
  }, [companionId, capabilities, revision])
  const close = (): void => { if (busy) return; setOpened(undefined); setRevision(v => v + 1) }
  const manage = (key: Resource): ReactNode => <button className="dsh-partner-capability-manage" type="button" disabled={disabled || (key !== 'access' && !capabilities.includes(key))} aria-haspopup="dialog" aria-label={`管理${titles[key]}`} onClick={() => { setBusy(false); setOpened(key) }}>管理{counts[key] !== undefined ? ` · ${counts[key]}` : ''}</button>
  return <>
    {children(manage)}
    {failed && <p className="dsh-partner-inline-note">部分数量读取失败，可打开管理重试。<button type="button" onClick={() => setRevision(v => v + 1)}>刷新数量</button></p>}
    {opened && <WorkspaceDialog className="is-capability-resources" eyebrow="" title={`管理${titles[opened]}`} detail={opened === 'access' ? '选择此伙伴可以访问和委派的伙伴，单向授权。' : '选择需要启用的能力，修改自动保存，下一轮生效。'} close={close}>
      {busy && <p role="status" className="dsh-partner-inline-note">正在保存，请稍候…</p>}
      {opened === 'skills' && <CompanionSkillSettings companionId={companionId} onBusyChange={setBusy} />}
      {opened === 'access' && <CompanionAccessPanel companionId={companionId} onBusyChange={setBusy} />}
      {opened === 'mcp' && <CompanionMcpSettings companionId={companionId} embedded onBusyChange={setBusy} />}
    </WorkspaceDialog>}
  </>
}
