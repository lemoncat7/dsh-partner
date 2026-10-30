import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { fatigueLabel, fatigueValue } from '../character/fatigue.js'
import { isSleeping, sleepPolicy, type SleepPolicy, type SleepState } from '../character/sleep.js'
import { errorMessage } from './workspace-components.js'

export function SleepEditor({ companion, value, disabled, active, onChange }: { companion: CompanionView; value: SleepPolicy; disabled: boolean; active: boolean; onChange(value: SleepPolicy): void }): JSX.Element {
  const [state, setState] = useState<SleepState>(companion.sleepState ?? {})
  const [error,setError] = useState<string>(), [waking,setWaking] = useState(false)
  const [now,setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    let alive=true,running=false
    setState(companion.sleepState ?? {});setError(undefined);setNow(Date.now())
    const refresh=async()=>{if(running||document.hidden)return;running=true;try{const data=await api<{state:SleepState;serverNow:number}>(`/companions/${encodeURIComponent(companion.id)}/sleep`);if(alive){setState(data.state);setNow(data.serverNow??Date.now());setError(undefined)}}catch(e){if(alive)setError(errorMessage(e))}finally{running=false}}
    void refresh(); const timer=setInterval(()=>void refresh(),15000)
    return ()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,companion.updatedAt])
  const sleeping=isSleeping({...companion,sleepState:state},now), episode=state.episode
  const fatigue=Math.round(fatigueValue({...companion,sleepState:state},now))
  const wakingSlowly=sleeping&&state.reception?.state==='sleeping'&&now-state.reception.at<10*60_000
  const wake=async()=>{setWaking(true);setError(undefined);try{await api(`/companions/${encodeURIComponent(companion.id)}/sleep`,{method:'POST',body:JSON.stringify({action:'wake'})});const data=await api<{state:SleepState;serverNow:number}>(`/companions/${encodeURIComponent(companion.id)}/sleep`);setState(data.state);setNow(data.serverNow??Date.now())}catch(e){setError(errorMessage(e))}finally{setWaking(false)}}
  return <section className="dsh-partner-character" aria-label="睡眠与做梦">
    <header><div><h3>自主睡眠 <small>可选</small></h3><p>想休息时就睡一会儿，不设固定作息时间。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启自主睡眠" aria-checked={value.enabled} data-on={value.enabled} disabled={disabled} onClick={()=>onChange({...value,enabled:!value.enabled})}><i aria-hidden="true"/></button><span>{value.enabled?'已开启':'已关闭'}</span></div></header>
    <p className="dsh-partner-character-hint">疲惫越高，空闲时越容易睡着。私聊会先有迷糊回应，连续呼唤逐渐叫醒；也可以立即叫醒。开关保存后生效。</p>
    {value.enabled&&<div className="dsh-partner-fatigue">
      <div className="dsh-partner-fatigue-line"><span>疲惫值 <strong>{fatigue}</strong><small> / 100</small></span><span>{fatigueLabel(fatigue)}</span></div>
      <div className="dsh-partner-fatigue-track" role="meter" aria-label={`${companion.name}的疲惫值`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fatigue} aria-valuetext={`${fatigue} / 100，${fatigueLabel(fatigue)}`}><span style={{transform:`scaleX(${fatigue/100})`}}/></div>
      <p className="dsh-partner-character-hint">清醒时慢慢累积，按实际睡眠时间恢复。叫醒后仍会保留疲惫。</p>
    </div>}
    {value.enabled&&<div className="dsh-partner-sleep-dream-option"><div><h4>睡眠时可以做梦</h4><p>可能无梦，也可能分段做梦。被打断只保留已完成的梦段，梦境独立保存，不改写事实记忆。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="允许做梦" aria-checked={value.dreamsEnabled} data-on={value.dreamsEnabled} disabled={disabled} onClick={()=>onChange({...value,dreamsEnabled:!value.dreamsEnabled})}><i aria-hidden="true"/></button><span>{value.dreamsEnabled?'已开启':'已关闭'}</span></div></div>}
    {value.enabled&&value.dreamsEnabled&&!companion.automation.memory.enabled&&<p className="dsh-partner-character-hint">当前没有开启记忆：可以休息，但不会读取旧记忆或生成梦境。可在记忆设置中开启。</p>}
    <div className="dsh-partner-sleep-status" role="status"><div><small>当前生效状态</small><h4>{!sleepPolicy(companion).enabled?'自主睡眠未开启':sleeping?(wakingSlowly?'迷迷糊糊':episode?.dream==='generating'?'正在做梦':'正在休息'):'清醒'}</h4><p>{sleeping?`预计 ${new Date(episode!.wakeAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} 自然醒，也可以随时叫醒。`:episode?.wokeAt?`最近醒来：${new Date(episode.wokeAt).toLocaleString()} · ${episode.wakeReason??'已醒来'}`:'空闲时会按疲惫值决定是否休息，角色也可以主动选择睡觉。'}</p>{sleeping&&<p>{wakingSlowly?`已经呼唤 ${state.reception!.calls} 次，正在慢慢清醒。`:episode?.reason}</p>}</div>{sleeping&&<button type="button" disabled={disabled||waking} onClick={()=>void wake()}>{waking?'正在唤醒…':'立即叫醒'}</button>}</div>
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <div className="dsh-partner-character-section"><h4>最近的梦 <small>想象与感受 · 不是真实记忆</small></h4>
      {!(state.dreams?.length)&&<p className="dsh-partner-character-hint">还没有留下梦境。不是每次睡眠都会做梦，醒来也不会自动发消息。</p>}
      {episode?.dream==='interrupted'&&<p className="dsh-partner-character-hint">当前梦段已中断，之前做完的片段仍保留。</p>}
      {episode?.dream==='failed'&&<p className="dsh-partner-character-hint">这次梦境没有生成完成，原记忆不受影响。</p>}
      {[...(state.dreams??[])].reverse().map(d=><details key={d.id} className="dsh-partner-settings-advanced dsh-partner-dream"><summary>{new Date(d.at).toLocaleString()} <small>{d.segment?`梦段 ${d.segment}`:'梦境'}</small></summary><p>{d.narrative}</p>{d.feeling&&<p><strong>醒后的感受</strong><br/>{d.feeling}</p>}{d.topic&&<p><strong>想到的话题</strong><br/>{d.topic}</p>}</details>)}
    </div>
  </section>
}
