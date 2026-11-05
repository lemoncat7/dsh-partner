import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import type { ReviewReceipt } from '../character/interaction-review.js'
import { affectionProgress } from '../character/affection.js'
import type { CharacterCard } from '../character/domain.js'
import { errorMessage } from './workspace-components.js'

export function AffectionPanel({companion,card,active,disabled,onChange}:{companion:CompanionView;card:CharacterCard;active:boolean;disabled:boolean;onChange(card:CharacterCard):void}):JSX.Element {
  const [progress,setProgress]=useState<ReturnType<typeof affectionProgress> & {review?:ReviewReceipt | undefined}>(()=>({...affectionProgress(companion.affection),review:companion.interactionReview?.affection}))
  const [error,setError]=useState<string>()
  const [revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(false)
  useEffect(()=>{
    if(!active)return
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const value=await api<ReturnType<typeof affectionProgress> & {review?:ReviewReceipt | undefined}>(`/companions/${encodeURIComponent(companion.id)}/character/affection`);if(alive){setProgress(value);setError(undefined)}}
      catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,revision])
  const enabled=card.affectionEnabled!==false
  return <div className="dsh-partner-affection" aria-label="好感度">
    <div className="dsh-partner-affection-line"><span>好感度 <strong>{progress.score}</strong><small> / −100～100</small></span><span>{progress.lastChange?`最近一次 ${progress.lastChange.delta>0?'+':''}${progress.lastChange.delta}`:'尚无变化'}</span><button type="button" role="switch" className="dsh-partner-switch" aria-label="启用好感度变化" aria-checked={enabled} data-on={enabled} disabled={disabled} onClick={()=>onChange({...card,affectionEnabled:!enabled})}><i aria-hidden="true"/></button></div>
    <div className="dsh-partner-affection-track" role="meter" aria-label={`${companion.name}的好感度`} aria-valuemin={-100} aria-valuemax={100} aria-valuenow={progress.score} aria-valuetext={`${progress.score}，0 为既定关系基线`}><span data-negative={progress.score<0} style={{left:`${progress.score<0?50+progress.score/2:50}%`,width:`${Math.abs(progress.score)/2}%`}}/><i aria-hidden="true"/></div>
    <div className="dsh-partner-affection-scale" aria-hidden="true"><span>−100</span><span>0</span><span>+100</span></div>
    <small className="dsh-partner-affection-caption">{!card.enabled||!enabled?'已暂停，进度保留':'随真实相处变化 · 表现遵循人物和关系设定'}</small>
    <p className="dsh-partner-affection-caption">0 是既定关系的起点，不表示陌生。变化需有真实互动依据，每条消息只记一次，每次 ±1～5；没有每日配额，不因聊天次数自动加分，也不因离线或正常拒绝扣分。短暂情绪不等于长期好感变化，分数不改变身份、权限或办事质量。</p>
    <small className="dsh-partner-affection-caption">{!companion.automation.memory.enabled?'自动检查随记忆学习暂停；聊天中仍可主动记录变化':progress.review?`最近检查 ${new Date(progress.review.at).toLocaleString()} · ${{changed:'已变化',unchanged:'保持不变',limited:'达到变化限制',stale:'等待重新检查',failed:'检查失败'}[progress.review.outcome]}：${progress.review.reason}`:'等待下一次真实互动后的后台检查'}</small>
    <details><summary>最近变化与原因</summary>{!progress.history.length?<p className="dsh-partner-affection-caption">尚无变化记录。检查结果可在上方查看；没有充分依据时保持不变。</p>:<ol className="dsh-partner-affection-history">{[...progress.history].reverse().map(item=><li key={item.turnId}><span>{item.delta>0?'+':''}{item.delta} → {item.score} · {new Date(item.at).toLocaleString()}</span><p>{item.reason}</p><details><summary>互动依据</summary><p>{item.evidence}</p></details></li>)}</ol>}</details>
    {error&&<div className="dsh-partner-affection-error"><small role="alert">进度读取失败</small><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>重试</button></div>}
  </div>
}
