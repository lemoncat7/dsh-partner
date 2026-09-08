import {useRef, useState} from 'react'
import {api, type MemoryView} from '../../client-api.js'
import {WorkspaceDialog, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {MemoryCard} from './memory-cards.js'
import {MEMORY_STATUS} from './types.js'

export function MemoryDetail({companionId, item, close, changed}: {companionId: string; item: MemoryView; close(): void; changed(): Promise<void>}): JSX.Element {
  const [current, setCurrent] = useState(item)
  const [editing, setEditing] = useState<MemoryView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const lock = useRef(false)
  const run = async (remove = false): Promise<void> => {
    if (lock.current || (!remove && !editing)) return
    lock.current = true; setBusy(true); setError(undefined)
    try {
      const path = `/companions/${encodeURIComponent(companionId)}/memory/${encodeURIComponent(current.id)}`
      if (remove) {await api(path, {method: 'DELETE'}); close()}
      else {
        const updated = await api<MemoryView>(path, {method: 'PUT', body: JSON.stringify({subject: editing!.subject, content: editing!.content})})
        setCurrent(updated); setEditing(undefined); setNotice('修正已保存，并锁定为用户确认的内容')
      }
      await changed()
    } catch (reason) {setError(errorMessage(reason))}
    finally {lock.current = false; setBusy(false)}
  }
  return <WorkspaceDialog title="记忆详情" detail={`${MEMORY_STATUS[current.status]} · 修改后的内容会优先保留；删除需要再次确认。`} close={() => {if (!busy) close()}}>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}{notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    <div className="dsh-partner-library-detail"><MemoryCard key={current.id} item={current} editing={editing} busy={busy} setEditing={setEditing} save={() => {void run()}} remove={() => {void run(true)}} /></div>
  </WorkspaceDialog>
}
