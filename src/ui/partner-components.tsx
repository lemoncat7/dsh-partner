import type { ReactNode } from 'react'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelView } from '../client-api.js'

export function ChannelStatus({ channel }: { channel: ChannelView | undefined }): JSX.Element {
  const status = channel?.runtimeStatus ?? 'unbound'
  return <span className={`dsh-partner-status is-${status}`}><i />{channel ? channelStatusLabel(channel.runtimeStatus) : '未连接'}</span>
}

export function Avatar({ name, small = false }: { name: string; small?: boolean }): JSX.Element {
  return <span className={`dsh-partner-avatar${small ? ' is-small' : ''}`} aria-hidden="true">{[...name][0] ?? '伴'}</span>
}

export function WeixinGlyph({ large = false }: { large?: boolean }): JSX.Element {
  return <span className={`dsh-partner-weixin-glyph${large ? ' is-large' : ''}`} aria-hidden="true"><i /><b /></span>
}

export function TabButton({ active, onClick, icon, children }: { active: boolean; onClick(): void; icon: ReactNode; children: ReactNode }): JSX.Element {
  return <button type="button" className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{children}</span></button>
}

export function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return <label className="dsh-partner-field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label>
}

export function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }): JSX.Element {
  return <header className="dsh-partner-section"><small>{eyebrow}</small><h2>{title}</h2><p>{detail}</p></header>
}

export function ContentState({ title, detail, action, compact = false }: { title: string; detail?: string; action?: ReactNode; compact?: boolean }): JSX.Element {
  return <div className={`dsh-partner-state${compact ? ' is-compact' : ''}`}><IconAgentPresetOutline16 size={20} /><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>
}

export function relativeTime(value: number): string {
  const minutes = Math.floor((Date.now() - value) / 60_000)
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`
}

function channelStatusLabel(status: ChannelView['runtimeStatus']): string {
  return status === 'running' ? '微信在线' : status === 'starting' ? '连接中' : status === 'error' ? '连接异常' : '已停用'
}
