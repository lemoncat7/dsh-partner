import { useEffect, useRef, useState } from 'react'
import { api, type ChannelView, type CompanionView } from '../client-api.js'
import { qqSettings } from '../channels/qq/settings.js'
import { findSettings, settingsCatalog, type SettingEntry, type SettingRequest, type SettingsGuideResult } from '../settings/catalog.js'
import { WorkspaceDialog, WorkspaceNotice, errorMessage } from './workspace-components.js'

export const SETTINGS_SEARCH_LABEL = '配置搜索与说明'

interface SettingsSearchSnapshot {
  query: string
  guide?: SettingsGuideResult
}

const lastSearchByCompanion = new Map<string, SettingsSearchSnapshot>()

function settingHint(entry: SettingEntry, companion: CompanionView, channel?: ChannelView): string {
  if (entry.needsRole && !companion.characterCard?.enabled) return '先开启角色聊天'
  if (entry.id === 'memory-review' && !companion.automation.memory.enabled) return '先开启学习与记忆'
  const target = entry.destination
  if (target.page !== 'weixin' || target.channel.dialog !== 'channel') return ''
  if (!channel) return target.channel.platform === 'bilibili' ? '先添加 B 站渠道' : '尚未接入，打开连接设置'
  if (!channel.enabled) return '渠道尚未启用'
  if (channel.runtimeStatus === 'error') return '渠道连接需要处理'
  if (entry.id === 'qq-autonomy') {
    const policy = qqSettings(channel.qq)
    if (!policy.groupReplies) return '先开启群聊回复'
    if (!policy.groupIds.length) return '先选择要回复的群'
    const count = policy.autonomousGroupIds.filter(id => policy.groupIds.includes(id)).length
    return count ? '已选 ' + count + ' 个自主回复群' : '还未添加自主回复群'
  }
  return ''
}

export function SettingsSearch({ companion, channels, onOpen, onClose }: {
  companion: CompanionView
  channels: ChannelView[]
  onOpen(request: SettingRequest): void
  onClose(): void
}): JSX.Element {
  const [{ query, guide }, setSearch] = useState<SettingsSearchSnapshot>(() =>
    lastSearchByCompanion.get(companion.id) ?? { query: '' },
  )
  const rememberSearch = (value: SettingsSearchSnapshot): void => {
    if (value.query) lastSearchByCompanion.set(companion.id, value)
    else lastSearchByCompanion.delete(companion.id)
    setSearch(value)
  }
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController>()
  useEffect(() => () => active.current?.abort(), [])
  const matches = findSettings(query).slice(0, 14)
  const guideEntries = guide?.settingIds.flatMap(id => settingsCatalog.find(entry => entry.id === id) ?? []) ?? []
  const question = query.trim()

  const ask = async (): Promise<void> => {
    if (!question || active.current) return
    const request = new AbortController()
    active.current = request
    setBusy(true); setError(undefined)
    try {
      const result = await api<SettingsGuideResult>('/companions/' + encodeURIComponent(companion.id) + '/settings-guide', {
        method: 'POST', body: JSON.stringify({ question }), signal: request.signal,
      })
      if (!request.signal.aborted) rememberSearch({ query, guide: result })
    } catch (reason) {
      if (!request.signal.aborted) setError(errorMessage(reason))
    } finally {
      if (active.current === request) { active.current = undefined; setBusy(false) }
    }
  }

  function links(entries: readonly SettingEntry[]) {
    return <ul className="dsh-partner-settings-results">{entries.flatMap(entry => {
      const target = entry.destination
      const platform = target.page === 'weixin' && target.channel.dialog === 'channel' ? target.channel.platform : undefined
      const selection = platform ? channels.filter(item => item.companionId === companion.id && item.platform === platform) : []
      const rows = selection.length ? selection : [undefined]
      return rows.map(item => {
        const hint = settingHint(entry, companion, item)
        return <li key={entry.id + ':' + (item?.id ?? '')}>
          <button type="button" onClick={() => onOpen({ entry, ...(item ? { channelId: item.id } : {}) })}>
            <strong>{entry.title}{rows.length > 1 && item ? ' · ' + item.name : ''}</strong>
            <small>{entry.path}</small>
            <span>{hint || entry.help}</span>
          </button>
        </li>
      })
    })}</ul>
  }

  return <WorkspaceDialog eyebrow="" title={SETTINGS_SEARCH_LABEL} detail={'当前伙伴 · ' + companion.name} close={onClose} width="wide">
    <div className="dsh-partner-settings-search">
      <label>
        <span className="dsh-partner-settings-search-label">设置名称或问题</span>
        <input type="search" aria-label="设置名称或问题" data-dialog-initial-focus autoComplete="off" value={query} maxLength={500}
          placeholder="不 @ 也回、怎么配置语音"
          onChange={event => {
            active.current?.abort(); active.current = undefined
            setBusy(false); setError(undefined); rememberSearch({ query: event.target.value })
          }}
        />
      </label>
      <button type="button" disabled={!question || busy} aria-busy={busy} onClick={() => void ask()}>{busy ? '正在查询…' : '问 AI'}</button>
    </div>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {guide && <section className="dsh-partner-settings-guide" aria-label="AI 设置引导">
      <p role="status">{guide.answer}</p>
      {guideEntries.length > 0 && links(guideEntries)}
    </section>}
    {matches.length > 0 ? links(matches) : question && !busy && !guide ? <p role="status" className="dsh-partner-settings-empty">没找到匹配的设置，可以换个说法或问 AI。</p> : null}
  </WorkspaceDialog>
}
