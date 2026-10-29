import { useEffect, useState } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { affectionProgress } from '../character/affection.js'
import type { CharacterCard } from '../character/domain.js'
import { errorMessage } from './workspace-components.js'

export function AffectionPanel({companion,card,active,disabled,onChange}:{companion:CompanionView;card:CharacterCard;active:boolean;disabled:boolean;onChange(card:CharacterCard):void}):JSX.Element {
  const [progress,setProgress]=useState(()=>affectionProgress(companion.affection))
  const [error,setError]=useState<string>()
  const [revision,setRevision]=useState(0)
  const [loading,setLoading]=useState(false)
  useEffect(()=>{
    if(!active)return
    let alive=true,running=false
    const refresh=async()=>{
      if(running||document.hidden)return
      running=true;setLoading(true)
      try{const value=await api<ReturnType<typeof affectionProgress>>(`/companions/${encodeURIComponent(companion.id)}/character/affection`);if(alive){setProgress(value);setError(undefined)}}
      catch(e){if(alive)setError(errorMessage(e))}finally{running=false;if(alive)setLoading(false)}
    }
    void refresh();const timer=setInterval(()=>void refresh(),30000)
    return()=>{alive=false;clearInterval(timer)}
  },[companion.id,active,revision])
  const enabled=card.affectionEnabled!==false
  return <div className="dsh-partner-affection" aria-label="好感度">
    <div className="dsh-partner-affection-line"><span>好感度 <strong>{progress.score}</strong><small>/100</small></span><span>Lv.{progress.level} · {progress.name}</span><button type="button" role="switch" className="dsh-partner-switch" aria-label="启用好感度累计与主动加成" aria-checked={enabled} data-on={enabled} disabled={disabled} onClick={()=>onChange({...card,affectionEnabled:!enabled})}><i aria-hidden="true"/></button></div>
    <div className="dsh-partner-affection-track" role="progressbar" aria-label={`${companion.name}的好感度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.score} aria-valuetext={`${progress.score} / 100，等级 ${progress.level}，${progress.name}`}><span style={{transform:`scaleX(${progress.score/100})`}}/></div>
    <small className="dsh-partner-affection-caption">{!card.enabled||!enabled?'已暂停，进度保留':`相处中慢慢积累 · 主动概率 ×${progress.multiplier.toFixed(2)}`}</small>
    {error&&<div className="dsh-partner-affection-error"><small role="alert">进度读取失败</small><button type="button" disabled={loading} onClick={()=>setRevision(n=>n+1)}>重试</button></div>}
  </div>
}
