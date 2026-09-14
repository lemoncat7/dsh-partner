import {useState, type ReactNode, type FormEvent} from 'react'
import {api, type CompanionView, type PartnerSnapshot, type PairingView} from '../client-api.js'
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
  return <div className="dsh-partner-form is-channel dsh-partner-channels">
    <div className="dsh-partner-channel-toolbar">
      <SectionHeading eyebrow="CHANNELS" title="我的渠道" detail="查看连接状态，管理联系人与通知投递。" />
      <button type="button" onClick={()=>openAdd()}>添加渠道</button>
    </div>
    {!adding&&feedback&&<p role="status">{feedback}</p>}
    {adding&&<WorkspaceDialog title={fixedPlatform?`${platform==='matrix'?'Matrix':'Mattermost'} 配置`:'添加渠道'} detail={platform==='matrix'?'先登录，再邀请机器人进入未加密双人房间并发消息配对。':'先登录，再向机器人发私聊消息，核对配对码后授权。'} close={()=>{if(!busy)closeAdd()}}>
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
    {channels.filter(c=>c.platform&&c.platform!=='weixin').map(channel=><div key={channel.id} className="dsh-partner-channel-row">
      <span><strong>{channel.name}</strong><small>{channel.platform} · {pairings.filter(p=>p.channelId===channel.id&&p.status==='pending').length} 个待授权</small></span><ChannelStatus channel={channel}/><button type="button" aria-label={`配置 ${channel.name}`} onClick={()=>{setFeedback('');setConfiguring(channel.id)}}>配置</button>
      {configuring===channel.id&&<WorkspaceDialog title={`${channel.name} · 配置`} detail="管理连接状态及联系人访问权限。" close={()=>{if(!busy){setConfiguring(undefined);setDeleting(undefined)}}}>
      <div className="dsh-partner-channel-detail dsh-partner-channel-manage">
      <div className="dsh-partner-channel-connection"><span><small>登录账号</small><strong>{channel.accountId}</strong>{channel.direct?.targetId&&<small>{channel.direct.targetId}</small>}</span><ChannelStatus channel={channel}/></div>
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
    </div>)}
    </div>
    <section className="dsh-partner-channel-notifications" aria-label="通知设置"><div className="dsh-partner-channel-row"><span><strong>通知与交付</strong><small>默认跟随最近渠道</small></span><button type="button" onClick={()=>setConfiguring('delivery')}>配置</button></div></section>
    {configuring==='delivery'&&<WorkspaceDialog title="通知与交付" detail="设置通知投递目标。" close={()=>setConfiguring(undefined)}><div className="dsh-partner-channel-detail"><p>本地与所有已授权渠道共用伙伴主对话，无需关联联系人。通知默认走最近收到消息的渠道；指定目标不可用时等待重试，不改发其他渠道。</p>
      {!pairings.some(p=>p.status==='approved')&&<p>批准联系人后，即可设置通知投递目标。</p>}
      {pairings.filter(p=>p.status==='approved').map(p=><DeliverySettings key={`${p.id}:${p.updatedAt}`} pairing={p} pairings={pairings} channels={channels} onChanged={onChanged}/>)}
    </div></WorkspaceDialog>}
  </div>
}

function FormField({label,hint,children}:{label:string;hint?:string;children:ReactNode}):JSX.Element {
  return <label className="dsh-partner-channel-field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>
}

function DeliverySettings({pairing,pairings,channels,onChanged}:{pairing:PairingView;pairings:PairingView[];channels:PartnerSnapshot['channels'];onChanged():Promise<void>}):JSX.Element {
  const contactKey=pairing.contactKey??''
  const [target,setTarget]=useState(pairing.deliveryTarget ? pairings.find(p=>p.status==='approved'&&p.channelId===pairing.deliveryTarget?.channelId&&p.userId===pairing.deliveryTarget?.userId)?.id??'unavailable' : '')
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  return <form className="dsh-partner-feature-form dsh-partner-channel-form" onSubmit={e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');void api(`/pairings/${pairing.id}/delivery`,{method:'POST',body:JSON.stringify({contactKey,targetPairingId:target||null})}).then(onChanged).catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false))}}>
    <h4>{channels.find(c=>c.id===pairing.channelId)?.name} · {pairing.displayName}</h4>
    <FormField label="通知投递目标"><select disabled={busy} value={target} onChange={e=>setTarget(e.target.value)}><option value="">自动：该联系人最近渠道</option>{target==='unavailable'&&<option value="unavailable" disabled>原指定目标不可用，请明确重新选择</option>}{pairings.filter(p=>p.status==='approved').map(p=><option key={p.id} value={p.id}>{channels.find(c=>c.id===p.channelId)?.name} · {p.displayName}</option>)}</select></FormField>
    <div className="dsh-partner-form-actions"><span role="alert">{error}</span><button disabled={busy}>保存投递设置</button></div>
  </form>
}
