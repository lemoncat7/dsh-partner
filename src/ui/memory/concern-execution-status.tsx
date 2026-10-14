import {useRef,useState} from 'react'
import {api,type ConcernExecutionView} from '../../client-api.js'
import {errorMessage} from '../workspace-components.js'

export function ConcernExecutionStatus({companionId,execution,disabled,onChanged}:{companionId:string;execution:ConcernExecutionView;disabled:boolean;onChanged():Promise<void>}):JSX.Element {
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const lock=useRef(false)
  const recover=async()=>{
    if(lock.current)return
    lock.current=true;setBusy(true);setError('');setNotice('')
    try {
      const r=await api<{reason:string}>(`/companions/${encodeURIComponent(companionId)}/concerns/${encodeURIComponent(execution.concernId)}/retry-execution`,{method:'POST',body:JSON.stringify({mode:'recover',executionId:execution.id,expectedUpdatedAt:execution.updatedAt})})
      setNotice(r.reason);await onChanged()
    }catch(e){setError(errorMessage(e))}finally{lock.current=false;setBusy(false)}
  }
  const labels={pending:'恢复／执行已排队',running:execution.recoveryFromMessageId?'正在核对并恢复执行':'正在会话中执行',completed:'本次执行已返回答复（交付结果见会话）',failed:'执行未完成，需要恢复'}
  return <div className="dsh-partner-concern-decision dsh-partner-concern-execution-status" data-decision={execution.status==='failed'?'defer':'feed'}>
    <strong role="status">{labels[execution.status]}</strong>
    {execution.status==='failed'&&<><span>{execution.error || '上次执行未完成。'}</span><span>重新检查只核验来源，不会恢复上次执行。恢复时先查已有图片、文件和外部记录，再继续缺失步骤。</span><div className="dsh-partner-concern-actions"><button type="button" disabled={disabled||busy} aria-busy={busy} onClick={()=>{void recover()}}>{busy?'正在提交恢复…':'核对产物并恢复'}</button></div></>}
    {notice&&<span role="status">{notice}</span>}{error&&<span role="alert">{error}</span>}
  </div>
}
