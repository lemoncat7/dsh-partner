import { useEffect, useState } from 'react'
import { api } from '../client-api.js'
import type { CompanionHabit, HabitCheck } from '../character/habits.js'
import { errorMessage } from './workspace-components.js'
function scopeLabel(scope:string):string{try{const [channel,person]=JSON.parse(scope);return String(person).startsWith('group:')?'群 '+String(person).slice(6):'私聊 '+person+' · '+channel}catch{return '原会话'}}
type Data={habits:CompanionHabit[];check?:HabitCheck;inactiveIds?:string[]}
export function HabitsPanel({companionId}:{companionId:string}):JSX.Element {
 const [data,setData]=useState<Data>({habits:[]}),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const path='/companions/'+encodeURIComponent(companionId)+'/habits'
 useEffect(()=>{let active=true;const refresh=()=>api<Data>(path).then(d=>{if(active)setData(d)}).catch(e=>{if(active)setError(errorMessage(e))});void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh()},30000);return()=>{active=false;clearInterval(timer)}},[path])
 const change=async(h:CompanionHabit,action:string)=>{setBusy(true);setError('');try{setData(await api<Data>(path,{method:'POST',body:JSON.stringify({id:h.id,expectedAt:h.updatedAt,action})}))}catch(e){setError(errorMessage(e))}finally{setBusy(false)}}
 return <div className="dsh-partner-character-fields" aria-label="自主习惯记录">
  {data.check&&<p className="dsh-partner-character-hint">最近检查：{new Date(data.check.at).toLocaleString()} · {data.check.reason}</p>}
  {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
  {!data.habits.length&&<p className="dsh-partner-character-hint">还没有形成习惯。一次偶然反应不会立即变成固定偏好。</p>}
  {data.habits.map(h=><details key={h.id} className="dsh-partner-memory-record"><summary><span style={{overflowWrap:'anywhere'}}>{h.text}</span> · {data.inactiveIds?.includes(h.id)?'已失效':{candidate:'观察中',active:'已形成',paused:'已暂停'}[h.status]}</summary><div className="dsh-partner-character-fields"><small>{h.scope==='global'?'通用兴趣':h.scope.startsWith('local:')?'网页会话':scopeLabel(h.scope)} · {h.evidence.length} 次依据 · {new Date(h.updatedAt).toLocaleString()}</small><details><summary>形成依据</summary>{h.evidence.map(e=><p key={e.id} style={{overflowWrap:'anywhere'}}>{e.excerpt}<br/><small>{new Date(e.at).toLocaleString()}</small></p>)}</details><div className="dsh-partner-actions"><button type="button" disabled={busy} onClick={()=>void change(h,h.status==='paused'||data.inactiveIds?.includes(h.id)?'resume':'pause')}>{h.status==='paused'||data.inactiveIds?.includes(h.id)?'重新观察':'暂停'}</button><button type="button" disabled={busy} onClick={()=>void change(h,'delete')}>删除</button></div></div></details>)}
 </div>
}
