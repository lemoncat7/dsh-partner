import { useState, type ReactNode } from 'react'
import type { Capability } from '../client-api.js'
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
  const close = (): void => { if (busy) return; setOpened(undefined) }
  const manage = (key: Resource): ReactNode => <button className="dsh-partner-capability-manage" type="button" disabled={disabled || (key !== 'access' && !capabilities.includes(key))} aria-haspopup="dialog" aria-label={`管理${titles[key]}`} onClick={() => { setBusy(false); setOpened(key) }}>管理</button>
  return <>
    {children(manage)}
    {opened && <WorkspaceDialog className="is-capability-resources" eyebrow="" title={`管理${titles[opened]}`} detail={opened === 'access' ? '选择此伙伴可以访问和委派的伙伴，单向授权。' : '选择需要启用的能力，修改自动保存，下一轮生效。'} close={close}>
      {busy && <p role="status" className="dsh-partner-inline-note">正在保存，请稍候…</p>}
      {opened === 'skills' && <CompanionSkillSettings companionId={companionId} onBusyChange={setBusy} />}
      {opened === 'access' && <CompanionAccessPanel companionId={companionId} onBusyChange={setBusy} />}
      {opened === 'mcp' && <CompanionMcpSettings companionId={companionId} embedded onBusyChange={setBusy} />}
    </WorkspaceDialog>}
  </>
}
