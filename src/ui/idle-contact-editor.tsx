import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { DEFAULT_IDLE_CONTACT, type IdleContactPolicy } from '../character/idle-contact.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

export function IdleContactEditor({companionId,value,disabled,onChange}:{companionId:string;value:IdleContactPolicy|undefined;disabled:boolean;onChange(value:IdleContactPolicy):void}):JSX.Element {
  const policy=value??DEFAULT_IDLE_CONTACT
  const [snapshot,setSnapshot]=useState<PartnerSnapshot>(),[error,setError]=useState<string>()
  useEffect(()=>{let active=true;void loadPartner().then(s=>{if(active)setSnapshot(s)}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false}},[companionId])
  const routes=snapshot?.sessions.filter(r=>r.companionId===companionId&&!r.archived&&(r.kind==='local'||(snapshot.channels.some(c=>c.id===r.channelId&&c.enabled)&&snapshot.pairings.some(p=>p.channelId===r.channelId&&p.userId===r.userId&&p.status==='approved'))))??[]
  const patch=(p:Partial<IdleContactPolicy>)=>onChange({...policy,...p})
  return <section className="dsh-partner-character" aria-label="闲时主动联系">
    <header><div><h3>闲时主动联系 <small>可选</small></h3><p>一段时间没聊天时，让伙伴按自己的性格主动来聊一句。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启闲时主动联系" aria-checked={policy.enabled} data-on={policy.enabled} disabled={disabled} onClick={()=>patch({enabled:!policy.enabled})}><i aria-hidden="true"/></button><span>{policy.enabled?'已开启':'已关闭'}</span></div></header>
    <p className="dsh-partner-character-hint">你没回复就不再追发，正在聊天或执行任务时会等待。使用当前身份；无需开启角色聊天。修改后保存身份生效。</p>
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    {policy.enabled&&<fieldset disabled={disabled} className="dsh-partner-character-fields">
      <Field label="联系到哪里" hint="只发送到所选会话，不群发其他渠道；渠道消息同时保留在对应聊天历史里。"><select required value={policy.routeId} onChange={e=>patch({routeId:e.target.value})}><option value="">选择一个会话</option>{routes.map(r=><option key={r.id} value={r.id}>{r.kind==='local'?'网页聊天':`${snapshot?.channels.find(c=>c.id===r.channelId)?.name??'渠道'} · ${snapshot?.pairings.find(p=>p.channelId===r.channelId&&p.userId===r.userId)?.displayName??r.userId}`}</option>)}</select></Field>
      {snapshot&&!routes.length&&<p>还没有可用会话，先在网页或已授权渠道和伙伴聊一次。</p>}
      <div className="dsh-partner-fields two"><Field label="空闲多久后联系" hint="以最近的真实对话为准，最短 30 分钟。"><select value={policy.idleMinutes} onChange={e=>patch({idleMinutes:Number(e.target.value)})}>{[...new Set([30,60,120,240,480,1440,policy.idleMinutes])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n<60?`${n} 分钟`:`${n/60} 小时`}</option>)}</select></Field></div>
      <header className="dsh-partner-quiet-header"><div><h3>免打扰</h3><p>开启后，在设定的时段暂停主动联系。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启免打扰" aria-checked={policy.quietEnabled !== false} data-on={policy.quietEnabled !== false} onClick={()=>patch({quietEnabled:policy.quietEnabled === false})}><i aria-hidden="true"/></button><span>{policy.quietEnabled !== false?'已开启':'已关闭'}</span></div></header>
      {policy.quietEnabled !== false && <div className="dsh-partner-fields two">{(['quietStartHour','quietEndHour'] as const).map((key,i)=><Field key={key} label={i?'免打扰结束':'免打扰开始'}><select value={policy[key]} onChange={e=>patch({[key]:Number(e.target.value)})}>{Array.from({length:24},(_,h)=><option key={h} value={h}>{String(h).padStart(2,'0')}:00</option>)}</select></Field>)}</div>}
      <p className="dsh-partner-character-hint">按服务配置的时区（默认亚洲 / 上海）计算，每分钟检查。起止时间相同表示全天可联系。不限制每天联系次数；你没回复就不连续追发，重启也不会重复已尝试的联系。</p>
    </fieldset>}
  </section>
}
