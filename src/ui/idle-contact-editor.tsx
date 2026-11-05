import { HabitsPanel } from './habits-panel.js'
import { ThoughtsPanel } from './thoughts-panel.js'
import {channelReplyAllowed} from '../channels/reply-access.js'
import { useEffect, useState } from 'react'
import { loadPartner, type PartnerSnapshot } from '../client-api.js'
import { DEFAULT_IDLE_CONTACT, type IdleContactPolicy } from '../character/idle-contact.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

export function IdleContactEditor({companionId,value,disabled,onChange}:{companionId:string;value:IdleContactPolicy|undefined;disabled:boolean;onChange(value:IdleContactPolicy):void}):JSX.Element {
  const policy=value??DEFAULT_IDLE_CONTACT
  const [snapshot,setSnapshot]=useState<PartnerSnapshot>(),[error,setError]=useState<string>()
  useEffect(()=>{let active=true;void loadPartner().then(s=>{if(active)setSnapshot(s)}).catch(e=>{if(active)setError(errorMessage(e))});return()=>{active=false}},[companionId])
  const routes=snapshot?.sessions.filter(r=>r.companionId===companionId&&!r.archived&&(r.kind==='local'||(snapshot.channels.some(c=>c.id===r.channelId&&c.enabled)&&channelReplyAllowed(snapshot,r.channelId,r.userId))))??[]
  const review=snapshot?.companions.find(c=>c.id===companionId)?.interactionReview?.persona
  const patch=(p:Partial<IdleContactPolicy>)=>onChange({...policy,...p})
  return <section className="dsh-partner-character" aria-label="自主活动">
    <header><div><h3>自主活动 <small>可选</small></h3><p>空闲时唤起伙伴，由它决定下一步，也可以安静待着。</p></div><div className="dsh-partner-character-toggle"><button type="button" role="switch" className="dsh-partner-switch" aria-label="开启自主活动" aria-checked={policy.enabled} data-on={policy.enabled} disabled={disabled} onClick={()=>patch({enabled:!policy.enabled})}><i aria-hidden="true"/></button><span>{policy.enabled?'已开启':'已关闭'}</span></div></header>
    <p className="dsh-partner-character-hint">消息和行动结果让伙伴继续思考；空闲时按下面的频率唤起。伙伴可以自行选择稍后继续的时间与会话，好感度不再换算成发言概率。新消息优先，睡眠期间等待。修改后保存身份生效。</p>
    {error&&<p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <ThoughtsPanel companionId={companionId}/>
    <div className="dsh-partner-character-fields">
      <div className="dsh-partner-persona-option"><div><span id="persona-refinement-label">自主习惯</span><small>{policy.habitsEnabled?'已开启':'已关闭'}</small></div><button type="button" role="switch" className="dsh-partner-switch" aria-labelledby="persona-refinement-label" aria-describedby="persona-refinement-hint" aria-checked={policy.habitsEnabled===true} data-on={policy.habitsEnabled===true} disabled={disabled} onClick={()=>patch({habitsEnabled:!policy.habitsEnabled})}><i aria-hidden="true"/></button></div>
      <p id="persona-refinement-hint" className="dsh-partner-character-hint">从群聊、私聊和自主活动形成可变偏好，不改写角色正文。聊天习惯只用于原场合；自身活动可形成通用兴趣。三次独立依据且跨六小时后生效，最多保留 12 条，30 天无新依据停止使用。开启记忆学习后自动检查聊天；活动中也可自行整理。关闭后暂停学习和使用，已有记录保留。修改角色正文后，旧习惯停止使用。</p>
      <HabitsPanel companionId={companionId}/>
    </div>
    {policy.enabled&&<fieldset disabled={disabled} className="dsh-partner-character-fields">
      <Field label="默认活动会话" hint="没有特别想去的地方时在这里活动。伙伴可以自己安排去其他已授权会话；不会自动群发。"><select required value={policy.routeId} onChange={e=>patch({routeId:e.target.value})}><option value="">选择一个会话</option>{routes.map(r=><option key={r.id} value={r.id}>{r.kind==='local'?'网页聊天':`${snapshot?.channels.find(c=>c.id===r.channelId)?.name??'渠道'} · ${snapshot?.pairings.find(p=>p.channelId===r.channelId&&p.userId===r.userId)?.displayName??r.userId}`}</option>)}</select></Field>
      {snapshot&&!routes.length&&<p>还没有可用会话，先在网页或已授权渠道和伙伴聊一次。</p>}
      <Field label="空闲唤起频率" hint="没有自行安排下一步时，空闲达到此时间再唤起；唤起不代表必须发消息。"><select value={policy.idleMinutes} onChange={e=>patch({idleMinutes:Number(e.target.value)})}>{[...new Set([30,60,120,240,480,1440,policy.idleMinutes])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n<60?`${n} 分钟`:`${n/60} 小时`}</option>)}</select></Field>

    </fieldset>}
  </section>
}
