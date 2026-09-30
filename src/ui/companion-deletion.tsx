import { useEffect, useRef, useState } from 'react'
import { IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView } from '../client-api.js'
import { WorkspaceDialog, errorMessage } from './workspace-components.js'

export function CompanionDeletion({ companion, count, channelCount, onRemoved }: {
  companion: CompanionView; count: number; channelCount: number; onRemoved(id: string): Promise<void>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const remove = async () => {
    if (!open || locked.current || removed || count <= 1) return
    const id = companion.id
    locked.current = true; setBusy(true); setError('')
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(id)}?removeFiles=1`, { method: 'DELETE' })
      committed = true
      if (alive.current) { setRemoved(true); setOpen(false) }
      await onRemoved(id)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '伙伴已删除，页面刷新失败，请刷新页面：' : '删除失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="dsh-partner-overview-delete">
    <button type="button" className="is-danger" disabled={busy || removed || count <= 1} title={count <= 1 ? '至少保留一个伙伴' : undefined} onClick={() => { setError(''); setOpen(true) }}><IconTrashOutlineRegular size={16} />删除伙伴</button>
    {!open && error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    {open && <WorkspaceDialog title={`删除「${companion.name}」？`} detail="此操作不可撤销，只删除当前确认的伙伴。" close={() => { if (!locked.current) setOpen(false) }}>
      <p>将清理身份、记忆、持续关注、能力绑定、定时任务及专属目录中的全部文件。</p>
      <p>{channelCount ? `已绑定 ${channelCount} 个渠道。确认后会自动停止并删除这些渠道、登录凭据和联系人授权，无需先手动解绑。` : '该伙伴没有绑定渠道。'}</p>
      <p>DSH 原会话日志由宿主管理，不在此次删除范围。正在执行的任务及共享或异常目录仍会拦截删除。</p>
      {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
      <div className="dsh-partner-form-actions"><button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button><button type="button" className="is-danger" disabled={busy} onClick={() => { void remove() }}>{busy ? '正在删除…' : '确认删除'}</button></div>
    </WorkspaceDialog>}
  </div>
}
