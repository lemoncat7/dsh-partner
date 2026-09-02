import { useCallback, useEffect, useState } from 'react'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionAccessView } from '../client-api.js'
import { CollectionEmpty, WorkspaceNotice, errorMessage } from './workspace-components.js'

const CAPABILITY_LABELS: Record<string, string> = { knowledge: '知识库', skills: 'Skill', ssh: 'SSH', git: 'Git' }

export function CompanionAccessPanel({ companionId }: { companionId: string }): JSX.Element {
  const [access, setAccess] = useState<CompanionAccessView>({ targetIds: [], companions: [] })
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try { setAccess(await api<CompanionAccessView>(`/companions/${encodeURIComponent(companionId)}/access`)); setError(undefined) }
    catch (reason) { setError(errorMessage(reason)) }
  }, [companionId])
  useEffect(() => { void load() }, [load])

  const toggle = async (targetId: string): Promise<void> => {
    const previous = access.targetIds
    const targetIds = previous.includes(targetId) ? previous.filter(id => id !== targetId) : [...previous, targetId]
    setBusy(targetId); setAccess(current => ({ ...current, targetIds })); setError(undefined)
    try {
      const result = await api<{ targetIds: string[] }>(`/companions/${encodeURIComponent(companionId)}/access`, { method: 'PUT', body: JSON.stringify({ targetIds }) })
      setAccess(current => ({ ...current, targetIds: result.targetIds }))
    } catch (reason) { setAccess(current => ({ ...current, targetIds: previous })); setError(errorMessage(reason)) }
    finally { setBusy(undefined) }
  }

  return <section className="dsh-partner-capability-detail dsh-partner-access" aria-labelledby="dsh-partner-access-title">
    <header><span><small>DIRECTED ACCESS</small><strong id="dsh-partner-access-title">可访问的伙伴</strong></span><em>{access.targetIds.length} 位已授权</em></header>
    <p className="dsh-partner-access-note">勾选后，当前伙伴能了解对方的公开能力，并在任务看板中 `@` 对方执行任务。授权只沿当前方向生效，不会反向授权，也不会共享会话、记忆、渠道或凭据。</p>
    {access.companions.length === 0 ? <CollectionEmpty title="还没有可授权的伙伴" detail="创建第二位伙伴后，可以在这里建立单向协作授权。" /> : <div className="dsh-partner-access-list">{access.companions.map(companion => {
      const selected = access.targetIds.includes(companion.id)
      const abilities = companion.capabilities.map(capability => CAPABILITY_LABELS[capability] ?? capability)
      return <button type="button" key={companion.id} className={selected ? 'is-active' : ''} aria-pressed={selected} disabled={busy === companion.id} onClick={() => { void toggle(companion.id) }}>
        <span className="dsh-partner-access-avatar" aria-hidden="true">{initials(companion.name)}</span>
        <span className="dsh-partner-access-copy"><strong>@{companion.name}</strong><small>{companion.role}</small><p>{companion.description || '未填写伙伴说明'}</p><span>{[...abilities, ...companion.enabledSkills.map(skill => skill.name)].map(item => <em key={item}>{item}</em>)}</span></span>
        <span className="dsh-partner-access-check" aria-hidden="true">{selected && <IconCheckOutline16 size={15} />}</span>
      </button>
    })}</div>}
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
  </section>
}

function initials(name: string): string { return [...name.trim()].slice(0, 2).join('').toUpperCase() || 'AI' }
