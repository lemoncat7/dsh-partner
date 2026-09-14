import { IconBrowseOutline16, IconEditOutline16, IconListPenOutline16, IconPlayOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { TabButton } from './partner-components.js'
export { GeneralSettingsPanel } from './storage-settings.js'

export type WorkspacePage = 'skills' | 'board' | 'schedules' | 'pendant' | 'general'
export const workspaceGroups = [
  { id: 'features', label: '功能', detail: '能力、协作与计划', icon: IconBrowseOutline16, pages: [
    { id: 'skills', label: 'Skill 市场', icon: IconBrowseOutline16 },
    { id: 'board', label: '任务看板', icon: IconListPenOutline16 },
    { id: 'schedules', label: '定时任务', icon: IconPlayOutline16 },
  ] },
  { id: 'settings', label: '设置', detail: '基本设置与卡片外观', icon: IconEditOutline16, pages: [
    { id: 'general', label: '基本设置', icon: IconEditOutline16 },
    { id: 'pendant', label: '卡片设置', icon: IconEditOutline16 },
  ] },
] as const
export const workspaceGroup = (page: string) => workspaceGroups.find(group => group.pages.some(item => item.id === page))

export function WorkspaceGroupLinks({ view, open, compact = false }: { view: string; open(page: WorkspacePage): void; compact?: boolean }) {
  const active = workspaceGroup(view)
  return <>{workspaceGroups.map(group => <button key={group.id} type="button" className={active?.id === group.id ? 'is-active' : ''} aria-current={active?.id === group.id ? 'page' : undefined} onClick={() => { if (active?.id !== group.id) open(group.pages[0].id) }}>
    <span aria-hidden="true"><group.icon size={16} /></span>{compact ? <span>{group.label}</span> : <><strong>{group.label}</strong><small>{group.detail}</small></>}
  </button>)}</>
}

export function WorkspaceGroupTabs({ view, open }: { view: string; open(page: WorkspacePage): void }) {
  const group = workspaceGroup(view)
  if (!group) return null
  return <nav className="dsh-partner-tabs dsh-partner-group-tabs" aria-label={`${group.label}标签页`}>{group.pages.map(page => <TabButton key={page.id} active={view === page.id} onClick={() => open(page.id)} icon={<page.icon size={16} />}>{page.label}</TabButton>)}</nav>
}
