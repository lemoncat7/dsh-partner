import {useId, useRef, useState} from 'react'
import {IconChevronDownOutline14} from '@deepseek-ai/dsh-client-ui-primitives'
import {api, type ConcernView} from '../../client-api.js'
import {WorkspaceDialog, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {useMemoryResource} from './use-memory-resource.js'

export function ConcernDeleteButton({companionId, item, disabled, onDeleted}: {companionId:string; item:ConcernView; disabled?:boolean; onDeleted():Promise<void>}) {
  const [open,setOpen]=useState(false)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const lock=useRef(false)
  const close=()=>{if(!lock.current)setOpen(false)}
  const remove=async()=>{
    if(lock.current)return
    lock.current=true;setBusy(true);setError('')
    try{
      await api(`/companions/${encodeURIComponent(companionId)}/concerns/${encodeURIComponent(item.id)}`,{method:'DELETE',body:JSON.stringify({expectedUpdatedAt:item.updatedAt})})
      await onDeleted();setOpen(false)
    }catch(e){setError(errorMessage(e))}finally{lock.current=false;setBusy(false)}
  }
  return <><button type="button" className="is-danger" disabled={disabled} onClick={()=>{setError('');setOpen(true)}}>删除关注</button>{open && <WorkspaceDialog eyebrow="DELETE CONCERN" title={`删除「${item.subject}」？`} detail="删除关注及其内部观察、审计记录，不能撤销。关联的知识文档、笔记和文件不会删除；已发送到聊天或渠道的消息仍会保留。" close={close}>
    {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
    <div className="dsh-partner-concern-actions"><button type="button" autoFocus disabled={busy} onClick={close}>保留关注</button><button type="button" className="is-danger" disabled={busy} onClick={()=>{void remove()}}>{busy?'删除中…':'确认删除'}</button></div>
  </WorkspaceDialog>}</>
}

export function ArchivedConcerns({companionId, onChanged}: {companionId:string; onChanged():Promise<void>}) {
  const contentId=useId()
  const [open,setOpen]=useState(false)
  const [offset,setOffset]=useState(0)
  const resource=useMemoryResource<{items:ConcernView[];hasMore:boolean}>(open?`/companions/${encodeURIComponent(companionId)}/concerns/archived?offset=${offset}`:undefined)
  const refresh=async()=>{await resource.reload();await onChanged()}
  return <section className="dsh-partner-concern-archive"><button type="button" className="dsh-partner-concern-archive-toggle" aria-label="已归档关注 · 查看与清理" aria-expanded={open} aria-controls={open?contentId:undefined} onClick={()=>setOpen(!open)}><span><strong>已归档关注</strong><small>已停止关注，可按需清理</small></span><IconChevronDownOutline14 size={16}/></button>{open && <div id={contentId} className="dsh-partner-concern-archive-content">
    {resource.error && <WorkspaceNotice>{resource.error}<button type="button" onClick={()=>{void resource.reload()}}>重试</button></WorkspaceNotice>}
    {!resource.data ? !resource.error && <p role="status">正在读取…</p> : <>{resource.data.items.length===0 && <p>此页没有已归档关注。</p>}<div className="dsh-partner-concern-archive-list">{resource.data.items.map(item=><article key={item.id} className="dsh-partner-concern-archive-row"><details className="dsh-partner-concern-archive-details"><summary><IconChevronDownOutline14 size={14}/><strong>{item.subject}</strong></summary><dl><dt>执行说明与记录格式</dt><dd>{item.reason || '未填写'}</dd><dt>检查依据</dt><dd>{item.resources?.map(source=>source.label || source.locator).join('、') || '未关联'}</dd><dt>记录位置</dt><dd>{item.recordTarget?.label || '伙伴内部观察记录（未指定文档）'}</dd></dl><p>已停止后续检查。删除关注不会删除关联文档。</p></details><div className="dsh-partner-concern-archive-action"><ConcernDeleteButton companionId={companionId} item={item} onDeleted={refresh}/></div></article>)}</div>
    {(offset>0 || resource.data.hasMore) && <nav className="dsh-partner-concern-archive-pages" aria-label="归档关注分页"><span>第 {Math.floor(offset/50)+1} 页</span><div><button type="button" disabled={offset===0 || resource.loading} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button><button type="button" disabled={!resource.data.hasMore || resource.loading} onClick={()=>setOffset(offset+50)}>下一页</button></div></nav>}</>}
  </div>}</section>
}
