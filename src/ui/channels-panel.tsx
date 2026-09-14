import {useState, type ReactNode, type FormEvent} from 'react'
import {api, type CompanionView, type PartnerSnapshot} from '../client-api.js'
import {NotificationSettings} from './notification-settings.js'
import {SectionHeading, ChannelStatus} from './partner-components.js'
import {errorMessage, WorkspaceDialog} from './workspace-components.js'

export function ChannelsPanel({companion,snapshot,onChanged,weixin}: {companion:CompanionView;snapshot:PartnerSnapshot;onChanged():Promise<void>;weixin:ReactNode}):JSX.Element {
  const [platform,setPlatform]=useState<'matrix'|'mattermost'>('matrix')
  const [name,setName]=useState('')
  const [baseUrl,setBaseUrl]=useState('')
  const [targetId,setTargetId]=useState('')
  const [botToken,setToken]=useState('')
  const [authMode,setAuthMode]=useState<'password'|'token'>('password')
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[mfaToken,setMfaToken]=useState('')
  const [busy,setBusy]=useState(false)
  const [feedback,setFeedback]=useState('')
  const [deleting,setDeleting]=useState<string>()
  const [adding,setAdding]=useState(false)
  const [fixedPlatform,setFixedPlatform]=useState(false)
  const [configuring,setConfiguring]=useState<string>()
  const closeAdd=()=>{setAdding(false);setToken('');setPassword('');setMfaToken('')}
  const openAdd=(selected?:'matrix'|'mattermost')=>{
    setFixedPlatform(Boolean(selected));setPlatform(selected??'matrix');setName('');setBaseUrl('');setTargetId('');setUsername('');setPassword('');setToken('');setMfaToken('');setAuthMode('password');setFeedback('');setAdding(true)
  }
  const channels=snapshot.channels.filter(c=>c.companionId===companion.id)
  const pairings=snapshot.pairings.filter(p=>channels.some(c=>c.id===p.channelId))
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setFeedback('');try{await action()}catch(error){setFeedback(errorMessage(error))}finally{setBusy(false)}}
  const configure=async(save:boolean)=>run(async()=>{
    const body={companionId:companion.id,platform,name:name.trim()||platform,baseUrl:baseUrl.trim(),targetId:targetId.trim(),authMode,...(authMode==='password'?{username,password,mfaToken}:{botToken:botToken.trim()})}
    await api(save?'/channels':'/channels/test',{method:'POST',body:JSON.stringify(body)})
    if(save){await onChanged();closeAdd()}
    setFeedback(save?'账号已保存。请启用渠道，再向机器人发送私聊消息，核对配对码并批准联系人。':'账号验证通过，可以保存。')
  })
  return <div id="dsh-partner-channels" className="dsh-partner-form is-channel dsh-partner-channels">
    <div className="dsh-partner-channel-toolbar">
      <SectionHeading eyebrow="CHANNELS" title="我的渠道" detail="查看连接状态，管理联系人与通知投递。" />
      <button type="button" onClick={()=>openAdd()}>添加渠道</button>
    </div>
    {!adding&&feedback&&<p role="status">{feedback}</p>}
    {adding&&<WorkspaceDialog title={fixedPlatform?`${platform==='matrix'?'Matrix':'Mattermost'} 配置`:'添加渠道'} detail={platform==='matrix'?'仅未加密的双人会话可获取配对码。请新建未开启端到端加密的会话，邀请机器人后发送文字消息。':'先登录，再向机器人发私聊消息，核对配对码后授权。'} close={()=>{if(!busy)closeAdd()}}>
      <form className="dsh-partner-feature-form dsh-partner-channel-form" aria-busy={busy} onSubmit={(event:FormEvent)=>{event.preventDefault();void configure(true)}}>
        {!fixedPlatform&&<FormField label="平台"><select autoFocus disabled={busy} value={platform} onChange={e=>{setPlatform(e.target.value as typeof platform);setPassword('');setToken('');setMfaToken('');setTargetId('');setFeedback('')}}><option value="matrix">Matrix</option><option value="mattermost">Mattermost</option></select></FormField>}
        <FormField label="渠道名称"><input autoFocus={fixedPlatform} disabled={busy} maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder={`例如：我的 ${platform==='matrix'?'Matrix':'Mattermost'}`} /></FormField>
        <FormField label="服务器地址"><input disabled={busy} required type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://chat.example.com" /></FormField>
        <details><summary>高级配置（可选）</summary><FormField label={platform==='matrix'?'固定房间 ID':'固定 DM 会话 ID'} hint="留空则自动发现私聊，通过配对授权。填写后仅监听指定会话。"><input disabled={busy} value={targetId} onChange={e=>setTargetId(e.target.value)} placeholder={platform==='matrix'?'!room:example.com':'DM channel ID'} /></FormField></details>
        <FormField label="登录方式"><select disabled={busy} value={authMode} onChange={e=>{setAuthMode(e.target.value as typeof authMode);setToken('');setPassword('');setMfaToken('')}}><option value="password">账号密码</option><option value="token">Access Token</option></select></FormField>
        {authMode==='password'?<>
          <FormField label="账号"><input disabled={busy} required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder={platform==='matrix'?'@账号:服务器域名':'用户名或邮箱'}/></FormField>
          <FormField label="密码" hint="仅用于换取令牌，不保存密码；请优先使用 HTTPS 服务器。"><input disabled={busy} required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></FormField>
          {platform==='mattermost'&&<FormField label="双重验证验证码（如已开启）"><input disabled={busy} autoComplete="one-time-code" inputMode="numeric" value={mfaToken} onChange={e=>setMfaToken(e.target.value)}/></FormField>}
        </>:<FormField label="Access Token" hint="仅保存至 DSH 凭据库；建议 HTTPS，HTTP 会明文传输凭据。"><input disabled={busy} required type="password" autoComplete="new-password" value={botToken} onChange={e=>setToken(e.target.value)} /></FormField>}
        {feedback&&<p role="status">{feedback}</p>}
        <footer><button type="button" disabled={busy} onClick={closeAdd}>取消</button><button type="button" disabled={busy||!(authMode==='password'?username&&password:botToken)||!baseUrl} onClick={()=>void configure(false)}>测试连接</button><button className="is-primary" disabled={busy}>{busy?'处理中…':'保存渠道'}</button></footer>
      </form>
    </WorkspaceDialog>}
    <div className="dsh-partner-channel-list">
    <div className="dsh-partner-channel-row">
      <span><strong>微信</strong><small>{channels.some(c=>!c.platform||c.platform==='weixin')?'管理连接与私聊授权':'尚未连接 · 扫码接入'}</small></span>{channels.find(c=>!c.platform||c.platform==='weixin')&&<ChannelStatus channel={channels.find(c=>!c.platform||c.platform==='weixin')!}/>}<button type="button" aria-label="配置微信" onClick={()=>setConfiguring('weixin')}>配置</button>
      {configuring==='weixin'&&<WorkspaceDialog title="微信配置" detail="管理扫码登录、连接与联系人授权。" close={()=>setConfiguring(undefined)}>{weixin}</WorkspaceDialog>}
    </div>
    {(['matrix','mattermost'] as const).filter(platform=>!channels.some(c=>c.platform===platform)).map(platform=><div className="dsh-partner-channel-row" key={platform}><span><strong>{platform==='matrix'?'Matrix':'Mattermost'}</strong><small>尚未连接</small></span><button type="button" aria-label={`配置 ${platform}`} onClick={()=>openAdd(platform)}>配置</button></div>)}
    {channels.filter(c=>c.platform&&c.platform!=='weixin').map(channel=><div key={channel.id} className="dsh-partner-channel-row has-notice-slot">
      <span><strong>{channel.name}</strong><small>{channel.platform} · {pairings.filter(p=>p.channelId===channel.id&&p.status==='pending').length} 个待授权</small></span><ChannelStatus channel={channel}/><button type="button" aria-label={`配置 ${channel.name}`} onClick={()=>{setFeedback('');setConfiguring(channel.id)}}>配置</button>
      {configuring===channel.id&&<WorkspaceDialog title={`${channel.name} · 配置`} detail="管理连接状态及联系人访问权限。" close={()=>{if(!busy){setConfiguring(undefined);setDeleting(undefined)}}}>
      <div className="dsh-partner-channel-detail dsh-partner-channel-manage">
      <div className="dsh-partner-channel-connection"><span><small>登录账号</small><strong>{channel.accountId}</strong>{channel.direct?.targetId&&<small>{channel.direct.targetId}</small>}</span><ChannelStatus channel={channel}/></div>
      {channel.platform==='matrix'&&<p>仅支持未加密的双人会话。加密会话无法读取消息或发送配对码；请新建未开启端到端加密的会话，邀请机器人后发送文字消息。检测到加密会话时会在此提示，不影响其他未加密会话。</p>}
      {!channel.direct?.targetId&&<p>向机器人发私聊消息，在下方核对配对码后批准。请求会自动更新。</p>}
      {channel.lastError&&<p role="alert">{channel.lastError}</p>}
      <div className="dsh-partner-form-actions"><button disabled={busy} onClick={()=>void run(async()=>{await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:!channel.enabled})});await onChanged()})}>{channel.enabled?'停用':'启用'}</button>
        {channel.enabled&&channel.runtimeStatus==='error'&&<button disabled={busy} onClick={()=>void run(async()=>{await api(`/channels/${channel.id}/enabled`,{method:'POST',body:JSON.stringify({enabled:true})});await onChanged()})}>重连</button>}
        <button disabled={busy} onClick={()=>deleting===channel.id?void run(async()=>{await api(`/channels/${channel.id}`,{method:'DELETE'});setDeleting(undefined);await onChanged()}):setDeleting(channel.id)}>{deleting===channel.id?'确认删除配置与凭据':'删除渠道'}</button>
        {deleting===channel.id&&<button onClick={()=>setDeleting(undefined)}>取消</button>}
      </div>
      <section className="dsh-partner-channel-access"><h3>联系人授权</h3><p role="status">{pairings.filter(p=>p.channelId===channel.id&&p.status==='pending').length} 个等待批准 · 自动刷新</p>
      {pairings.filter(p=>p.channelId===channel.id).map(p=><div key={p.id} className="dsh-partner-channel-person"><div><strong>{p.displayName}</strong><small>{p.status==='approved'?'已授权':p.status==='pending'?'等待批准':'已阻止'}</small>{p.status==='pending'&&p.pairingCode&&<span>配对码 <code>{p.pairingCode}</code></span>}</div><button disabled={busy} onClick={()=>void run(async()=>{await api(`/pairings/${p.id}/status`,{method:'POST',body:JSON.stringify({status:p.status==='approved'?'blocked':'approved'})});await onChanged()})}>{p.status==='approved'?'撤销授权':'批准联系人'}</button></div>)}
      </section>
      {feedback&&<p role="status">{feedback}</p>}
    </div></WorkspaceDialog>}
      {channel.lastError&&<div className="dsh-partner-channel-inline-notice" role="status" aria-atomic="true"><strong>{channel.runtimeStatus==='running'?'会话提示':'连接提示'}</strong><p>{channel.lastError}</p></div>}
    </div>)}
    </div>
    <section className="dsh-partner-channel-notifications" aria-label="通知设置"><div className="dsh-partner-channel-row"><span><strong>通知与交付</strong><small>{companion.notificationDelivery?.mode==='selected'?`已指定 ${companion.notificationDelivery.targets.length} 位接收人`:'默认跟随最近渠道与用户'}</small></span><button type="button" onClick={()=>setConfiguring('delivery')}>配置</button></div></section>
    {configuring==='delivery'&&<WorkspaceDialog title="通知与交付" detail="选择通知渠道，再选择各渠道的接收人；支持同时投递。" close={()=>setConfiguring(undefined)}><NotificationSettings companion={companion} snapshot={snapshot} onChanged={onChanged}/></WorkspaceDialog>}
  </div>
}

function FormField({label,hint,children}:{label:string;hint?:string;children:ReactNode}):JSX.Element {
  return <label className="dsh-partner-channel-field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>
}
