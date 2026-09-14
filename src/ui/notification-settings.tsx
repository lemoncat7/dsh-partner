import {useState, useRef, useEffect} from 'react'
import {api, type CompanionView, type PartnerSnapshot} from '../client-api.js'
import {errorMessage} from './workspace-components.js'

export function NotificationSettings({companion,snapshot,onChanged}:{companion:CompanionView;snapshot:PartnerSnapshot;onChanged():Promise<void>}):JSX.Element {
  const channels=snapshot.channels.filter(c=>c.companionId===companion.id)
  const pairings=snapshot.pairings.filter(p=>channels.some(c=>c.id===p.channelId))
  const [mode,setMode]=useState(companion.notificationDelivery?.mode??'recent')
  const [targets,setTargets]=useState(companion.notificationDelivery?.targets??[])
  const [selectedChannels,setSelectedChannels]=useState(targets.map(t=>t.channelId))
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState(''),[failed,setFailed]=useState(false)
  const saveRef=useRef<HTMLButtonElement>(null)
  useEffect(()=>{if(!busy&&feedback&&document.activeElement===document.body)saveRef.current?.focus()},[busy,feedback])
  const unavailable=targets.filter(t=>!pairings.some(p=>p.channelId===t.channelId&&p.userId===t.userId&&p.status==='approved')||!channels.some(c=>c.id===t.channelId&&c.enabled))
  const emptyChannel=selectedChannels.some(id=>!targets.some(t=>t.channelId===id))
  return <form className="dsh-partner-feature-form dsh-partner-channel-form dsh-partner-delivery-form" aria-busy={busy} onSubmit={e=>{
    e.preventDefault();if(busy)return;setBusy(true);setFeedback('');setFailed(false)
    const targetPairingIds=targets.map(t=>pairings.find(p=>p.channelId===t.channelId&&p.userId===t.userId)?.id)
    void api(`/companions/${companion.id}/notifications`,{method:'PUT',body:JSON.stringify({mode,targetPairingIds:mode==='recent'?[]:targetPairingIds})}).then(async()=>{await onChanged();setFeedback('通知设置已保存')}).catch(error=>{setFailed(true);setFeedback(errorMessage(error))}).finally(()=>setBusy(false))
  }}>
    <label className="dsh-partner-channel-field"><span>通知发送到</span><select disabled={busy} value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="recent">最近联系的渠道与用户</option><option value="selected">指定渠道与接收人</option></select></label>
    <p>仅影响主动通知与结果交付。对话回复仍发送到消息来源渠道。</p>
    {!companion.notificationDelivery&&pairings.some(p=>p.deliveryTarget)&&<p role="status">当前仍使用旧的联系人投递规则，保存后统一使用这里的通知设置。</p>}
    {mode==='selected'&&<div className="dsh-partner-notification-choices">
      <p>可选择多个渠道；每个渠道至少选择一位已授权接收人。保存后对新通知生效，待重试通知保留原接收人。</p>
      {!channels.length&&<p>请先添加渠道并授权联系人。</p>}
      {channels.map(channel=><fieldset key={channel.id} disabled={busy} className="dsh-partner-notification-channel">
        <legend><label><input type="checkbox" checked={selectedChannels.includes(channel.id)} onChange={e=>{
          setSelectedChannels(ids=>e.target.checked?[...ids,channel.id]:ids.filter(id=>id!==channel.id))
          if(!e.target.checked)setTargets(items=>items.filter(t=>t.channelId!==channel.id))
        }}/>{channel.name}{!channel.enabled?'（已停用）':''}</label></legend>
        {selectedChannels.includes(channel.id)&&<div className="dsh-partner-notification-users">
          {!pairings.some(p=>p.channelId===channel.id&&p.status==='approved')&&<p>暂无已授权接收人，请先在渠道配置中批准联系人。</p>}
          {pairings.filter(p=>p.channelId===channel.id&&p.status==='approved').map(p=><label key={p.id}><input type="checkbox" checked={targets.some(t=>t.channelId===p.channelId&&t.userId===p.userId)} onChange={e=>setTargets(items=>e.target.checked?[...items,{channelId:p.channelId,userId:p.userId}]:items.filter(t=>t.channelId!==p.channelId||t.userId!==p.userId))}/><span>{p.displayName}<small>{p.userId}</small></span></label>)}
        </div>}
      </fieldset>)}
      {unavailable.length>0&&<div role="alert"><p>部分已选接收人已失效或渠道已停用。请移除或恢复授权，不会自动改发其他人。</p>{unavailable.map(t=><button type="button" disabled={busy} key={JSON.stringify(t)} onClick={()=>{setTargets(items=>items.filter(x=>x.channelId!==t.channelId||x.userId!==t.userId));if(!targets.some(x=>x.channelId===t.channelId&&x.userId!==t.userId))setSelectedChannels(ids=>ids.filter(id=>id!==t.channelId))}}>移除 {t.userId}</button>)}</div>}
    </div>}
    {feedback&&<p role={failed?'alert':'status'}>{feedback}</p>}
    <footer><button ref={saveRef} className="is-primary" disabled={busy||(mode==='selected'&&(!targets.length||unavailable.length>0||emptyChannel))}>{busy?'保存中…':'保存通知设置'}</button></footer>
  </form>
}
