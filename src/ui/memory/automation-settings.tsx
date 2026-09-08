import {useRef, useState} from 'react'
import {api, type CompanionView, type AutomationView, type ModelCatalogView} from '../../client-api.js'
import {FormField as Field} from '../partner-components.js'
import {WorkspaceDialog, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {useMemoryResource} from './use-memory-resource.js'

export function AutomationSettings({companion, kind, close, onChanged}: {companion: CompanionView; kind: 'memory' | 'heartbeat'; close(): void; onChanged(): Promise<void>}): JSX.Element {
 const [automation,setAutomation] = useState<AutomationView>(()=>structuredClone(companion.automation))
 const lock = useRef(false)
 const [busy,setBusy] = useState(false)
 const [error,setError] = useState<string>()
 const [notice,setNotice] = useState<string>()
 const {data: modelCatalog,error: catalogError} = useMemoryResource<ModelCatalogView>(kind==='memory'?'/models':undefined)
 const inheritedProvider=companion.provider || modelCatalog?.defaultSelection.provider || ''
 const selectedProvider=automation.memory.provider || inheritedProvider
 const modelOptions=modelCatalog?.providers.find(item=>item.id===selectedProvider)?.models ?? []
 const save=async ():Promise<void>=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError(undefined);setNotice(undefined)
  try {await api('/companions/'+encodeURIComponent(companion.id)+'/automation',{method:'PUT',body:JSON.stringify({automation:{...companion.automation,[kind]:automation[kind]}})});setNotice('设置已保存');await onChanged()}
  catch(reason){setError(errorMessage(reason))}finally{lock.current=false;setBusy(false)}
 }
 const review=async ():Promise<void>=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError(undefined);setNotice(undefined)
  try {const result=await api<{reviewed:number;failed:number;reason?:string}>('/companions/'+encodeURIComponent(companion.id)+'/memory/review',{method:'POST'});setNotice(result.reason ?? '终审完成 '+result.reviewed+' 篇，失败 '+result.failed+' 篇');await onChanged()}
  catch(reason){setError(errorMessage(reason))}finally{lock.current=false;setBusy(false)}
 }
 return <WorkspaceDialog title={kind==='memory'?'记忆设置':'持续关注设置'} detail={kind==='memory'?'管理学习、历史保留与每日整理。有效的长期认识独立保留。':'持续关注用于观察变化；定时执行工作请使用定时任务。'} close={()=>{if(!busy)close()}}>
  <div className="dsh-partner-memory-settings">{(error || catalogError) && <WorkspaceNotice>{error || catalogError}</WorkspaceNotice>}{notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
  {kind==='memory'?(<section className="dsh-partner-automation">
      <header><span><strong>学习与长期记忆</strong><small>按联系人归档完整对话，提炼每日回顾和结构化记忆，并在相关话题出现时召回。</small></span><button type="button" className="dsh-partner-switch" disabled={busy} role="switch" data-on={automation.memory.enabled} aria-checked={automation.memory.enabled} aria-label="启用伙伴学习" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, enabled: !current.memory.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-memory-model"><Field label="历史保留期限" hint="不会删除仍有效的长期偏好"><select value={automation.memory.retentionDays} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, retentionDays: Number(event.target.value) } }))}><option value={0}>永久保留</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>1 年</option><option value={1095}>3 年</option></select></Field><Field label="提炼 Provider" hint="默认继承伙伴"><select value={automation.memory.provider ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, provider: event.target.value, model: '' } }))}><option value="">跟随伙伴 · {inheritedProvider || 'DSH 默认'}</option>{modelCatalog?.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></Field><Field label="提炼模型" hint="默认继承伙伴"><select value={automation.memory.model ?? ''} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, model: event.target.value } }))}><option value="">跟随伙伴 · {companion.model || modelCatalog?.defaultSelection.model || 'DSH 默认'}</option>{modelOptions.map(model => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></Field></div>
      <div className="dsh-partner-review-policy"><button type="button" className="dsh-partner-switch" disabled={busy} role="switch" data-on={automation.memory.dailyReviewEnabled} aria-checked={automation.memory.dailyReviewEnabled} aria-label="启用每日终审" onClick={() => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewEnabled: !current.memory.dailyReviewEnabled } }))}><i /></button><span><strong>每日终审</strong><small>次日自动合并重复、纠正偏差并建立记忆关系</small></span><label><select aria-label="每日终审时间" value={automation.memory.dailyReviewHour} onChange={event => setAutomation(current => ({ ...current, memory: { ...current.memory, dailyReviewHour: Number(event.target.value) } }))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label><button type="button" disabled={busy} onClick={() => { void review() }}>立即终审</button></div>
    </section>):(<section className="dsh-partner-automation">
      <header><span><strong>持续感知</strong><small>伙伴只观察尚未闭环的事情是否出现新变化，并由克制的打扰策略决定何时告诉你。</small></span><button type="button" className="dsh-partner-switch" disabled={busy} role="switch" data-on={automation.heartbeat.enabled} aria-checked={automation.heartbeat.enabled} aria-label="启用伙伴心跳" onClick={() => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, enabled: !current.heartbeat.enabled } }))}><i /></button></header>
      <div className="dsh-partner-automation-fields is-heartbeat">
        <Field label="检查间隔"><select value={automation.heartbeat.intervalMinutes} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, intervalMinutes: Number(event.target.value) } }))}><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={180}>3 小时</option><option value={360}>6 小时</option><option value={720}>12 小时</option><option value={1440}>24 小时</option></select></Field>
        <Field label="免打扰开始"><input type="number" min={0} max={23} value={automation.heartbeat.quietStartHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietStartHour: Number(event.target.value) } }))} /></Field>
        <Field label="免打扰结束"><input type="number" min={0} max={23} value={automation.heartbeat.quietEndHour} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, quietEndHour: Number(event.target.value) } }))} /></Field>
        <Field label="每日上限"><select value={automation.heartbeat.dailyLimit} onChange={event => setAutomation(current => ({ ...current, heartbeat: { ...current.heartbeat, dailyLimit: Number(event.target.value) } }))}><option value={0}>不限</option><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option><option value={5}>5 次</option><option value={8}>8 次</option></select></Field>
      </div>
</section>)}
  <footer className="dsh-partner-memory-actions"><button type="button" disabled={busy} onClick={close}>关闭</button><button type="button" className="is-primary" disabled={busy} onClick={()=>{void save()}}>{busy?'正在处理…':'保存设置'}</button></footer></div>
 </WorkspaceDialog>
}
