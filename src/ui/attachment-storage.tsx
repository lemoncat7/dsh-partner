import { useEffect, useState } from 'react'
import { api } from '../client-api.js'
import type { AttachmentStorageView, AttachmentCleanupResult } from '../attachments/storage-types.js'
import { WorkspaceBlock, WorkspaceDialog, errorMessage } from './workspace-components.js'

const size=(bytes:number)=>`${(bytes/1048576).toFixed(2)} MiB`
export function AttachmentStoragePanel(){
  const [view,setView]=useState<AttachmentStorageView>(),[limit,setLimit]=useState('512')
  const [owner,setOwner]=useState(''),[days,setDays]=useState('0'),[offset,setOffset]=useState(0)
  const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,setRevision]=useState(0)
  const [expanded,setExpanded]=useState(false)
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);setSelected([]);setError('')
    api<AttachmentStorageView>(`/attachments/storage?${new URLSearchParams({owner,days,offset:String(offset)})}`,{signal:controller.signal}).then(data=>{setView(data);setLimit(String(data.limitMiB))}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))}).finally(()=>{if(!controller.signal.aborted)setBusy(false)})
    return()=>controller.abort()
  },[owner,days,offset,revision])
  const save=async()=>{
    setBusy(true);setError('');setNotice('')
    try{await api('/attachments/storage',{method:'PUT',body:JSON.stringify({limitMiB:Number(limit)})});setNotice('额度已保存，立即生效；不会自动删除任何文件。');setRevision(v=>v+1)}catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  const clean=async()=>{
    setBusy(true);setError('');setNotice('')
    try{const result=await api<AttachmentCleanupResult>('/attachments/cleanup',{method:'POST',body:JSON.stringify({ids:selected,confirm:true})});setConfirm(false);setNotice(`已清理 ${result.removed} 个副本，释放 ${size(result.freedBytes)}；跳过 ${result.skipped} 个，失败 ${result.failed} 个。`);setRevision(v=>v+1)}catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  return <WorkspaceBlock title="附件存储" className="attachment-storage-block">
    <div id="partner-attachment-storage" className="dsh-partner-attachment-storage" aria-busy={busy}>
      <div className="attachment-storage-overview">
        <div className="attachment-storage-usage"><strong>{view?`${size(view.usedBytes)} / ${view.limitMiB} MiB`:'正在读取…'}</strong><small>{view?`${view.count} 个副本 · 全部伙伴共享`: '正在统计附件占用'}</small></div>
        <form onSubmit={e=>{e.preventDefault();void save()}}><label>额度<input aria-label="总额度（MiB）" type="number" min="64" max="1048576" step="1" required value={limit} disabled={busy} onChange={e=>setLimit(e.target.value)}/><span>MiB</span></label><button aria-label="保存额度" disabled={busy||!view||Number(limit)===view.limitMiB}>保存</button></form>
        <button type="button" aria-expanded={expanded} aria-controls="attachment-storage-manager" onClick={()=>setExpanded(v=>!v)}>{expanded?'收起明细':'管理副本'}</button>
      </div>
      {expanded&&<div id="attachment-storage-manager">
      <div className="attachment-storage-filters"><label>伙伴<select value={owner} disabled={busy} onChange={e=>{setOwner(e.target.value);setOffset(0)}}><option value="">全部伙伴</option>{view?.owners.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label><label>创建时间<select value={days} disabled={busy} onChange={e=>{setDays(e.target.value);setOffset(0)}}><option value="0">全部时间</option><option value="7">7 天以前</option><option value="30">30 天以前</option><option value="90">90 天以前</option></select></label><button disabled={busy} onClick={()=>setRevision(v=>v+1)}>刷新</button></div>
      <div className="attachment-storage-selection"><button disabled={busy||!view?.items.some(i=>!i.protectedReason)} onClick={()=>setSelected(selected.length?[]:view!.items.filter(i=>!i.protectedReason).map(i=>i.id))}>{selected.length?'取消选择':'选择本页'}</button><small>可清理 {size(view?.eligibleBytes??0)} · 使用中的副本受保护</small></div>
      <div className="attachment-storage-list">{view?.items.map(item=><label className="attachment-storage-row" key={item.id}><input type="checkbox" disabled={busy||!!item.protectedReason} checked={selected.includes(item.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,item.id]:ids.filter(id=>id!==item.id))}/><span><strong title={item.name}>{item.name}</strong><small>{item.companionName} · {size(item.size)} · {item.createdAt?new Date(item.createdAt).toLocaleString():'时间未知'} · {item.protectedReason??(item.channel==='sent'?'已发送':'会话副本')}</small></span></label>)}</div>
      {view&&!view.items.length&&<p>没有符合条件的副本。</p>}
      <div className="attachment-storage-filters"><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-30))}>上一页</button><span>第 {Math.floor(offset/30)+1} 页 · 共 {view?.filteredCount??0} 项</span><button disabled={busy||!view||offset+30>=view.filteredCount} onClick={()=>setOffset(offset+30)}>下一页</button><button disabled={busy||!selected.length} onClick={()=>setConfirm(true)}>清理所选（{selected.length}）</button></div>
      <details className="attachment-storage-help"><summary>存储与清理说明</summary><p>副本统一存放，原文件不受影响。不会自动清理；降低额度不删除旧副本，超额时停止新增。单文件上限 64 MiB。</p><p>发送中、失败待重试、最近 5 分钟创建及未完成任务/需求引用的副本不能清理。清理后对应历史下载链接失效。</p>{[...new Set(view?.owners.map(o=>o.directory)??[])].map(directory=><code key={directory}>{directory}</code>)}</details>
      </div>}
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div>
    {confirm&&<WorkspaceDialog eyebrow="附件管理" title="清理交付副本" detail={`已选择 ${selected.length} 个副本。此操作不可撤销。`} close={()=>{if(!busy)setConfirm(false)}}><form className="dsh-partner-feature-form" onSubmit={event=>{event.preventDefault();if(!busy)void clean()}}><p className="is-wide">只删除交付副本，原始文件保持不变。历史会话和看板中的对应附件下载链接将失效。执行时会再次检查保护状态。</p>{error&&<p className="is-wide" role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button type="submit" className="is-primary" disabled={busy}>{busy?'清理中…':'确认清理'}</button></footer></form></WorkspaceDialog>}
  </WorkspaceBlock>
}
