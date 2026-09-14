import { useEffect, useRef, useState } from 'react'
import { api } from '../client-api.js'
import type { StorageInspection } from '../storage/preflight.js'
import { WorkspaceBlock, WorkspaceDialog, errorMessage } from './workspace-components.js'
import { waitForStorage } from './storage-recovery.js'
import { clearStorageRecovery, pendingStorageRecovery, rememberStorageRecovery } from './storage-recovery-marker.js'

export function GeneralSettingsPanel() {
  const [version,setVersion]=useState<number>()
  const [inspection,setInspection]=useState<StorageInspection>()
  const [busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false)
  const [error,setError]=useState(''),[notice,setNotice]=useState('')
  const request=useRef<AbortController>()
  const mounted=useRef(true)
  const [reconnect,setReconnect]=useState(false)
  const [cleanupPending,setCleanupPending]=useState(0)
  const cleanup=version===1&&cleanupPending>0
  const recover=async(expected=pendingStorageRecovery())=>{
    request.current?.abort();const controller=new AbortController();request.current=controller
    setBusy(true);setError('');setReconnect(false)
    try{
      const status=await waitForStorage(controller.signal,()=>setNotice('迁移或服务重载中，正在自动等待恢复…请勿重复提交。'))
      clearStorageRecovery()
      setVersion(status.currentVersion);setInspection(undefined)
      setCleanupPending(status.cleanupPending??0)
      if(status.currentVersion>=status.targetVersion){
        setNotice(`已连接，存储版本 v${status.currentVersion}。${status.cleanupPending?'有旧路径尚未清理，原文件已保留，请核查。':'迁移已完成。'}${status.backupPath?` 完整备份：${status.backupPath}`:''}`)
      }else{setNotice('');if(expected!==undefined)setError(status.lastError||'服务已恢复，但迁移尚未提交。请重新检查原因，再手动迁移。')}
    }catch(e){if(!controller.signal.aborted){setNotice('');setError(errorMessage(e));setReconnect(true)}}
    finally{if(!controller.signal.aborted)setBusy(false)}
  }
  useEffect(()=>{mounted.current=true;void recover();return()=>{mounted.current=false;request.current?.abort()}},[])
  const inspect=async()=>{
    setBusy(true);setError('');setNotice('')
    try{const result=await api<StorageInspection>('/storage/inspect');setInspection(result);setVersion(result.currentVersion)}catch(e){setError(errorMessage(e))}finally{setBusy(false)}
  }
  const migrate=async()=>{
    if(busy||(!cleanup&&!inspection?.migrationAvailable))return
    setBusy(true);setError('');setConfirm(false);setNotice('正在提交迁移，完成后会自动重新连接…')
    const expected=cleanup?1:inspection!.targetVersion
    rememberStorageRecovery(expected)
    try {
      await api(cleanup?'/storage/cleanup':'/storage/migrate',{method:'POST',signal:AbortSignal.timeout(15000),body:JSON.stringify({confirm:true,expectedVersion:cleanup?1:inspection!.currentVersion})})
    }catch{if(mounted.current)setNotice('连接暂时中断，正在核对实际迁移结果…')}
    if(mounted.current)await recover(expected)
  }
  return <section className="dsh-partner-general-settings" aria-busy={busy}>
    <h2>基本设置</h2>
    <WorkspaceBlock title="升级迁移" detail="手动整理公共数据和每位伙伴的私有目录，不会自动执行。" actions={<button type="button" disabled={busy} onClick={()=>void inspect()}>{busy?'处理中…':'检查迁移'}</button>}>
      <p>数据存储版本：{version===undefined?'正在读取…':`v${version}${version===0?' · 待迁移':' · 已升级'}`}</p>
      <p>升级前请结束伙伴会话和后台执行。完整备份并校验后才清理已迁移的旧路径，不修改用户工作文档；服务重载后自动重新连接。</p>
      {inspection&&<>
        {inspection.steps.map(step=><p key={step.id}>v{step.from} → v{step.to} · {step.title}</p>)}
        <details><summary>查看目录与检查详情</summary><div className="dsh-partner-migration-paths">{inspection.items.map((item,i)=><div key={i}><strong>{item.label}</strong><code>{item.source}</code><span>迁移至</span><code>{item.target}</code><small>{item.exists?`${item.files} 个文件 · ${(item.bytes/1024/1024).toFixed(2)} MB`:'当前无文件'}</small></div>)}</div>{inspection.notices.map((text,i)=><p key={i}>{text}</p>)}</details>
        {!!inspection.blockers.length&&<div role="alert"><p>以下问题需要先处理：</p><ul>{inspection.blockers.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
        {inspection.migrationAvailable&&<button type="button" className="is-primary" disabled={busy} onClick={()=>setConfirm(true)}>升级迁移</button>}
      </>}
      {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {reconnect&&<button type="button" disabled={busy} onClick={()=>void recover()}>重新连接</button>}
      {cleanup&&<button type="button" disabled={busy} onClick={()=>setConfirm(true)}>重试清理旧路径</button>}
    </WorkspaceBlock>
    {confirm&&<WorkspaceDialog title={cleanup?'确认清理旧路径':'确认升级迁移'} detail={cleanup?'重新核对完整备份，只清理未变化的旧文件，不重新迁移活动数据。':'公共数据与所有伙伴私有数据将一起迁移，全部校验后才切换目录版本。'} close={()=>{if(!busy)setConfirm(false)}}><form className="dsh-partner-feature-form" onSubmit={event=>{event.preventDefault();void migrate()}}><p className="is-wide">先完整备份，版本提交后清理已核验的旧路径；历史记忆备份会原样归档。备份不会自动删除。迁移期间请勿编辑文件、修改插件配置或启动其他实例。</p><p className="is-wide">账号凭据和宿主会话不搬动。升级后不要直接安装不支持新版存储的旧插件。</p><footer><button type="button" disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button type="submit" className="is-primary" disabled={busy}>{busy?'正在处理，请勿关闭…':cleanup?'确认清理已备份的旧路径':'确认迁移目录和数据'}</button></footer></form></WorkspaceDialog>}
  </section>
}
