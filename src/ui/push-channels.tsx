import { useState } from 'react'
import { api, type CompanionView, type PartnerSnapshot } from '../client-api.js'
import type { PushChannelView } from '../notifications/push-domain.js'
import { DiscardChangesDialog, WorkspaceDialog, errorMessage } from './workspace-components.js'
import { BarkEditor } from './push-editor.js'

export function PushChannels({ companion, snapshot, onChanged, adding, closeAdd }: {
  companion: CompanionView; snapshot: PartnerSnapshot; onChanged(): Promise<void>; adding: boolean; closeAdd(): void
}): JSX.Element {
  const [editing, setEditing] = useState<PushChannelView>()
  const [removing, setRemoving] = useState<PushChannelView>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false)
  const closeEditor = () => { closeAdd(); setEditing(undefined); setDiscard(false); setDirty(false) }
  const channels = (snapshot.pushChannels ?? []).filter(c => c.companionId === companion.id)
  return <>
    {!channels.length && <div className="dsh-partner-channel-row"><span><strong>Bark</strong><small>iOS 单向通知 · 无需联系人授权</small></span><button type="button" onClick={() => setEditing(emptyChannel(companion.id))}>配置</button></div>}
    {channels.map(channel => <div className="dsh-partner-channel-row" key={channel.id}>
      <span><strong>{channel.name}</strong><small>Bark · {channel.targets.filter(t => t.enabled).length} 个启用目标 · {channel.enabled ? '自动推送' : '已停用'}{channel.pending ? ` · ${channel.pending} 条待发送` : ''}{channel.failed ? ` · ${channel.failed} 条失败` : ''}</small></span>
      <button type="button" aria-label={`配置 ${channel.name}`} onClick={() => setEditing(channel)}>配置</button>
    </div>)}
    {(adding || editing) && <WorkspaceDialog className="dsh-partner-bark-dialog" title={editing?.id ? `${editing.name} · Bark 配置` : '添加 Bark 渠道'} detail="保存启用后自动推送最终结果，不依赖联系人或“通知与交付”选项。" close={() => { if (!busy) { if (dirty) setDiscard(true); else closeEditor() } }}>
      <BarkEditor initial={editing ?? emptyChannel(companion.id)} onBusy={setBusy} onDirty={setDirty} onChanged={onChanged}
        onSaved={saved => { setEditing(saved); closeAdd() }}
        onDelete={channel => { setRemoving(channel); setEditing(undefined); closeAdd(); setError('') }} />
    </WorkspaceDialog>}
    {discard && <DiscardChangesDialog keepEditing={() => setDiscard(false)} discard={closeEditor} />}
    {removing && <WorkspaceDialog title="删除 Bark 渠道" detail={`删除“${removing.name}”及其设备凭据，并取消该渠道尚未发送的通知。其他渠道不受影响。`} close={() => { if (!busy) setRemoving(undefined) }}>
      {error && <p role="alert">{error}</p>}
      <div className="dsh-partner-form-actions"><button disabled={busy} onClick={() => setRemoving(undefined)}>取消</button><button disabled={busy} className="is-danger" onClick={() => {
        setBusy(true); void api(`/push-channels/${removing.id}`, { method: 'DELETE' }).then(async () => { await onChanged(); setRemoving(undefined) }).catch(e => setError(errorMessage(e))).finally(() => setBusy(false))
      }}>{busy ? '删除中…' : '确认删除'}</button></div>
    </WorkspaceDialog>}
  </>
}
export function emptyChannel(companionId: string): PushChannelView {
  return { id: '', companionId, name: '', platform: 'bark', baseUrl: '', enabled: true, revision: 0, createdAt: 0, updatedAt: 0,
    targets: [{ id: '', name: '我的 iPhone', enabled: true, configured: false }], notifyProblems: false, content: 'summary', group: '', sound: '', openUrl: '', pending: 0, failed: 0 }
}
