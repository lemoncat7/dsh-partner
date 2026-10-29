import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { isSleeping, sleepPolicy, type SleepPolicy, type SleepState } from '../character/sleep.js'
import { errorMessage } from './workspace-components.js'

export function SleepEditor({ companion, value, disabled, active, onChange }: { companion: CompanionView; value: SleepPolicy; disabled: boolean; active: boolean; onChange(value: SleepPolicy): void }): JSX.Element {
  const [state, setState] = useState<SleepState>(companion.sleepState ?? {})
  const [error,setError] = useState<string>(), [waking,setWaking] = useState(false)
  const [now,setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    let alive=true
    const refresh=async()=>{try{const data=await api<{state:SleepState}>(`/companions/${encodeURIComponent(companion.id)}/sleep`);if(alive){setState(data.state);setNow(Date.now());setError(undefined)}}catch(e){if(alive)setError(errorMessage(e))}}
    void refresh(); const timer=setInterval(()=>void refresh(),15000)
    return ()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,companion.updatedAt])
  const sleeping=isSleeping({...companion,sleepState:state},now), episode=state.episode
  const wake=async()=>{setWaking(true);setError(undefined);try{await api(`/companions/${encodeURIComponent(companion.id)}/sleep`,{method:'POST',body:JSON.stringify({action:'wake'})});const data=await api<{state:SleepState}>(`/companions/${encodeURIComponent(companion.id)}/sleep`);setState(data.state);setNow(Date.now())}catch(e){setError(errorMessage(e))}finally{setWaking(false)}}
  return <section className="dsh-partner-character" aria-label="睡眠与做梦">
    <header><div><h3>自主睡眠 <small>可选</small></h3><p>想休息时就睡一会儿，不设固定作息时间。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启自主睡眠" aria-checked={value.enabled} data-on={value.enabled} disabled={disabled} onClick={()=>onChange({...value,enabled:!value.enabled})}><i aria-hidden="true"/></button><span>{value.enabled?'已开启':'已关闭'}</span></div></header>
    <p className="dsh-partner-character-hint">睡眠只暂停闲时主动搭话。你发消息就会叫醒他，正常回复和任务不受限制。开关修改后保存身份生效。</p>
    {value.enabled&&<div className="dsh-partner-sleep-dream-option"><div><h4>睡眠时可以做梦</h4><p>从已有记忆产生联想、画面与感受，独立保存为梦，不改写真实记忆，也不清空上下文。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="允许做梦" aria-checked={value.dreamsEnabled} data-on={value.dreamsEnabled} disabled={disabled} onClick={()=>onChange({...value,dreamsEnabled:!value.dreamsEnabled})}><i aria-hidden="true"/></button><span>{value.dreamsEnabled?'已开启':'已关闭'}</span></div></div>}
    {value.enabled&&value.dreamsEnabled&&!companion.automation.memory.enabled&&<p className="dsh-partner-character-hint">当前没有开启记忆：可以休息，但不会读取旧记忆或生成梦境。可在记忆设置中开启。</p>}
    <div className="dsh-partner-sleep-status" role="status"><div><small>当前生效状态</small><h4>{!sleepPolicy(companion).enabled?'自主睡眠未开启':sleeping?(episode?.dream==='generating'?'正在做梦':'正在休息'):'清醒'}</h4><p>{sleeping?`预计 ${new Date(episode!.wakeAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} 自然醒，也可以随时叫醒。`:episode?.wokeAt?`最近醒来：${new Date(episode.wokeAt).toLocaleString()} · ${episode.wakeReason??'已醒来'}`:'由角色在聊天或空闲时自主决定是否休息，不强制每天睡觉。'}</p>{sleeping&&<p>{episode?.reason}</p>}</div>{sleeping&&<button type="button" disabled={disabled||waking} onClick={()=>void wake()}>{waking?'正在唤醒…':'叫醒他'}</button>}</div>
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <div className="dsh-partner-character-section"><h4>最近的梦 <small>想象与感受 · 不是真实记忆</small></h4>
      {!(state.dreams?.length)&&<p className="dsh-partner-character-hint">还没有留下梦境。不是每次睡眠都会做梦，醒来也不会自动发消息。</p>}
      {episode?.dream==='failed'&&<p className="dsh-partner-character-hint">这次梦境没有生成完成，原记忆不受影响。</p>}
      {[...(state.dreams??[])].reverse().map(d=><details key={d.id} className="dsh-partner-settings-advanced dsh-partner-dream"><summary>{new Date(d.at).toLocaleString()} <small>梦境</small></summary><p>{d.narrative}</p>{d.feeling&&<p><strong>醒后的感受</strong><br/>{d.feeling}</p>}{d.topic&&<p><strong>想到的话题</strong><br/>{d.topic}</p>}</details>)}
    </div>
  </section>
}
