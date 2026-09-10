import {useRef, useState} from 'react'
import {api, type ConcernView, type ConcernRecordTargetView} from '../../client-api.js'
import {ConcernRecordFields} from './concern-record-fields.js'
import {errorMessage} from '../workspace-components.js'

export function ConcernEditor({companionId, item, close, saved}: {companionId:string; item:ConcernView; close():void; saved():Promise<void>}) {
  const [subject,setSubject] = useState(item.subject)
  const [reason,setReason] = useState(item.reason)
  const [sources,setSources] = useState(item.resources.map(r => r.kind === 'knowledge' ? `@知识库[${r.locator}]` : `@"${r.locator}"`).join('\n'))
  const [target,setTarget] = useState<ConcernRecordTargetView | undefined>(item.recordTarget)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const lock=useRef(false)
  return <form className="dsh-partner-concern-compose" aria-label="编辑关注" aria-busy={busy} onSubmit={event=>{event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');void (async()=>{
    try {await api(`/companions/${encodeURIComponent(companionId)}/concerns/${encodeURIComponent(item.id)}`,{method:'PATCH',body:JSON.stringify({subject,reason,sources,recordTarget:target??null,expectedUpdatedAt:item.updatedAt})});await saved();close()}
    catch(e){setError(errorMessage(e))}finally{lock.current=false;setBusy(false)}
  })()}}>
    <header className="dsh-partner-concern-form-heading"><strong>编辑关注</strong><p>调整后续检查方式，已有观察记录保留。</p></header>
    <label><span>关注事项</span><input autoFocus required value={subject} maxLength={300} onChange={e=>setSubject(e.target.value)} /></label>
    <label><span>检查依据</span><textarea rows={3} value={sources} maxLength={4000} onChange={e=>setSources(e.target.value)} /><small>每行一个 @知识库[库名/文档名] 或 @"文件路径"；删除对应行即可取消关联。依据只读。</small></label>
    <ConcernRecordFields companionId={companionId} reason={reason} onReason={setReason} target={target} onTarget={setTarget} />
    <small>保留历史和关注状态；正在执行的检查使用原配置，修改从下轮生效。</small>
    {error && <p role="alert">{error}</p>}
    <div><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="is-primary" disabled={busy || !subject.trim()}>{busy?'保存中…':'保存修改'}</button></div>
  </form>
}
