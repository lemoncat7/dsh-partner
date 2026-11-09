import {useEffect,useState} from 'react'
import {api,type ChannelView} from '../client-api.js'
import type {TtsProfile,ChannelTts} from '../voice/domain.js'
import {supportsChannelTts} from '../voice/domain.js'
type Profile=Omit<TtsProfile,'credentialId'>&{credentialConfigured:boolean}
const fresh=():Record<string,any>=>({name:'BreezeBlue',provider:'breezeblue',endpoint:'https://api.breeze.blue',model:'breeze-tts-2',voice:'',language:'zh',speed:1,format:'wav',instructions:'',authHeader:'Authorization',authPrefix:'Bearer ',responseMode:'binary',responsePath:'audio',bodyTemplate:'{\n  "text": "{{text}}",\n  "voice": "{{voice}}",\n  "model": "{{model}}"\n}'})
export function TtsSettings({companionId,channels,onChanged,onEdit}:{companionId:string;channels:ChannelView[];onChanged():Promise<void>;onEdit(value:{dirty:boolean;busy:boolean}):void}):JSX.Element{
 const [profiles,setProfiles]=useState<Profile[]>([]),[form,setForm]=useState<Record<string,any>>(),[original,setOriginal]=useState(''),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false),[sample,setSample]=useState('你好，这是语音试听。'),[audio,setAudio]=useState(''),[bindingEdit,setBindingEdit]=useState({dirty:false,busy:false})
 const formDirty=!!form&&(JSON.stringify(form)!==original||!!key)
 useEffect(()=>{onEdit({dirty:formDirty||bindingEdit.dirty,busy:busy||bindingEdit.busy});return()=>onEdit({dirty:false,busy:false})},[formDirty,bindingEdit,busy,onEdit])
 const load=async()=>{const r=await api<{profiles:Profile[]}>(`/tts/profiles/${companionId}`);setProfiles(r.profiles)}
 useEffect(()=>{void load().catch(()=>{setFailed(true);setMessage('语音服务读取失败，请重新打开设置')})},[companionId])
 useEffect(()=>()=>{if(audio)URL.revokeObjectURL(audio)},[audio])
 const run=async(fn:()=>Promise<void>,done:string)=>{if(busy)return;setBusy(true);setMessage('');setFailed(false);try{await fn();setMessage(done)}catch(e){setFailed(true);setMessage(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}
 const edit=(p?:Profile)=>{if(formDirty&&!window.confirm('放弃尚未保存的服务修改？'))return;const value=p?{...fresh(),...p}:fresh();setForm(value);setOriginal(JSON.stringify(value));setKey('');setAudio('')}
 const change=(name:string,value:unknown)=>setForm(f=>({...f,[name]:value}))
 return <section className="dsh-partner-tts" aria-label="语音 TTS" aria-busy={busy}>
  <p className="dsh-partner-qq-hint">独立于消息渠道的语音服务，同一伙伴的多个渠道可共用。先添加服务，再选择哪些渠道使用；密钥不会交给模型。</p>
  <div className="dsh-partner-qq-actions"><strong>语音服务</strong><button disabled={busy} onClick={()=>edit()}>添加服务</button></div>
  {profiles.length===0&&<p className="dsh-partner-qq-hint">还没有外部服务。添加 BreezeBlue、OpenAI 兼容服务，或自定义同步 HTTP 接口。</p>}
  {profiles.map(p=><div className="dsh-partner-tts-service" key={p.id}><span><strong>{p.name}</strong><small>{p.provider} · {p.voice}</small></span><button disabled={busy} onClick={()=>edit(p)}>编辑与试听</button></div>)}
  {form&&<fieldset disabled={busy} className="dsh-partner-tts-editor"><legend>{form.id?'编辑语音服务':'添加语音服务'}</legend>
   <label className="dsh-partner-qq-field"><span>服务名称</span><input value={form.name} onChange={e=>change('name',e.target.value)} maxLength={80}/></label>
   <label className="dsh-partner-qq-field"><span>接口类型</span><select value={form.provider} onChange={e=>{const type=e.target.value;setForm(f=>({...f,provider:type,endpoint:type==='breezeblue'?'https://api.breeze.blue':type==='openai'?'https://api.openai.com/v1':'',model:type==='breezeblue'?'breeze-tts-2':type==='openai'?'tts-1':'',format:'wav',responseMode:'binary'}));setKey('')}}><option value="breezeblue">BreezeBlue</option><option value="openai">OpenAI 兼容 TTS</option><option value="http">自定义 HTTP（同步）</option></select></label>
   <label className="dsh-partner-qq-field"><span>{form.provider==='http'?'完整 POST 接口地址':'服务地址'}</span><input type="url" value={form.endpoint} onChange={e=>change('endpoint',e.target.value)}/><small>{form.provider==='breezeblue'?'例如 https://api.breeze.blue，不包含 /v1。':form.provider==='openai'?'例如 https://api.openai.com/v1，程序追加 /audio/speech。':'支持直接音频或 JSON Base64 响应；异步任务和下载链接暂不支持。'}</small></label>
   <label className="dsh-partner-qq-field"><span>API 密钥</span><input type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} placeholder={form.credentialConfigured?'已配置，留空保留':'填写密钥'}/><small>更换服务地址时需重新填写密钥。自建无鉴权 HTTP 接口可留空。</small></label>
   <div className="dsh-partner-tts-grid"><label className="dsh-partner-qq-field"><span>模型</span><input value={form.model} onChange={e=>change('model',e.target.value)}/></label><label className="dsh-partner-qq-field"><span>默认音色 ID</span><input value={form.voice} onChange={e=>change('voice',e.target.value)}/></label><label className="dsh-partner-qq-field"><span>语言</span><input value={form.language} onChange={e=>change('language',e.target.value)}/></label><label className="dsh-partner-qq-field"><span>语速</span><input type="number" min="0.5" max="2" step="0.05" value={form.speed} onChange={e=>change('speed',Number(e.target.value))}/></label></div>
   <label className="dsh-partner-qq-field"><span>音频格式</span><select value={form.format} onChange={e=>change('format',e.target.value)}><option value="wav">WAV</option><option value="mp3">MP3</option></select></label>
   <label className="dsh-partner-qq-field"><span>表演指令（可选）</span><textarea rows={2} value={form.instructions} onChange={e=>change('instructions',e.target.value)} maxLength={2000}/><small>留空沿用服务默认。仅支持该参数的模型会生效，不改变回复台词。</small></label>
   {form.provider==='http'&&<details open><summary>HTTP 接口映射</summary><label className="dsh-partner-qq-field"><span>鉴权 Header</span><input value={form.authHeader} onChange={e=>change('authHeader',e.target.value)}/></label><label className="dsh-partner-qq-field"><span>密钥前缀</span><input value={form.authPrefix} onChange={e=>change('authPrefix',e.target.value)}/><small>例如 Bearer 后带一个空格；不需要前缀时留空。</small></label><label className="dsh-partner-qq-field"><span>JSON 请求模板</span><textarea rows={6} value={form.bodyTemplate} onChange={e=>change('bodyTemplate',e.target.value)}/><small>{'变量：{{text}}、{{voice}}、{{model}}、{{speed}}、{{language}}、{{instructions}}、{{format}}。不要在模板写密钥。'}</small></label><label className="dsh-partner-qq-field"><span>响应类型</span><select value={form.responseMode} onChange={e=>change('responseMode',e.target.value)}><option value="binary">音频二进制</option><option value="base64">JSON Base64</option></select></label>{form.responseMode==='base64'&&<label className="dsh-partner-qq-field"><span>音频字段路径</span><input value={form.responsePath} onChange={e=>change('responsePath',e.target.value)} placeholder="data.audio"/></label>}</details>}
   <div className="dsh-partner-qq-actions"><button className="is-primary" onClick={()=>void run(async()=>{const saved=await api<Profile>(`/tts/profiles/${companionId}`,{method:'POST',body:JSON.stringify({...form,expectedUpdatedAt:form.updatedAt,apiKey:key})});const value={...fresh(),...saved};setForm(value);setOriginal(JSON.stringify(value));setKey('');await load();await onChanged()},'语音服务已保存')}>保存服务</button><button onClick={()=>{if(!formDirty||window.confirm('放弃尚未保存的修改？')){setForm(undefined);setKey('')}}}>关闭编辑</button>{form.id&&<button onClick={()=>{if(window.confirm('删除此语音服务？正在被渠道使用的服务不能删除。'))void run(async()=>{await api(`/tts/profiles/${companionId}`,{method:'DELETE',body:JSON.stringify({id:form.id,expectedUpdatedAt:form.updatedAt})});setForm(undefined);setKey('');await load();await onChanged()},'服务已删除')}}>删除服务</button>}</div>
   <hr className="dsh-partner-tts-divider"/><label className="dsh-partner-qq-field"><span>试听文字</span><input maxLength={200} value={sample} onChange={e=>setSample(e.target.value)}/><small>使用已保存配置生成音频，仅在当前页面播放，不发送到聊天。供应商可能计费。</small></label><button disabled={!form.id||formDirty||!sample.trim()} onClick={()=>void run(async()=>{const r=await api<{mediaType:string;audio:string}>(`/tts/preview/${companionId}`,{method:'POST',body:JSON.stringify({profileId:form.id,text:sample})});const bytes=Uint8Array.from(atob(r.audio),c=>c.charCodeAt(0));setAudio(URL.createObjectURL(new Blob([bytes],{type:r.mediaType})))},'试听已生成，点击播放')}>生成试听</button>{audio&&<audio controls src={audio} aria-label="TTS 试听音频"/>}
  </fieldset>}
  <hr className="dsh-partner-tts-divider"/>
  <ChannelTtsBindings channels={channels.filter(c=>c.companionId===companionId)} profiles={profiles} onChanged={onChanged} onEdit={setBindingEdit} disabled={busy||formDirty}/>
  {message&&<p role={failed?'alert':'status'} className="dsh-partner-qq-feedback">{message}</p>}
 </section>
}

const emptyConfig=():ChannelTts=>({enabled:false,profileId:'',voice:''})
function ChannelTtsBindings({channels,profiles,onChanged,onEdit,disabled}:{channels:ChannelView[];profiles:Profile[];onChanged():Promise<void>;onEdit(value:{dirty:boolean;busy:boolean}):void;disabled:boolean}):JSX.Element {
 const supported=channels.filter(c=>supportsChannelTts(c.platform))
 const [channelId,setChannelId]=useState(()=>supported[0]?.id??''),[draft,setDraft]=useState<{config:ChannelTts;original:ChannelTts;expectedAt:number}>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
 const channel=supported.find(c=>c.id===channelId)
 const config=draft?.config??channel?.tts??emptyConfig()
 const dirty=!!draft&&JSON.stringify(draft.config)!==JSON.stringify(draft.original)
 useEffect(()=>{onEdit({dirty,busy});return()=>onEdit({dirty:false,busy:false})},[dirty,busy,onEdit])
 useEffect(()=>{if(!channelId&&supported.length)setChannelId(supported[0]!.id)},[channelId,channels])
 const change=(patch:Partial<ChannelTts>)=>{if(!channel)return;setSaved(false);setDraft(d=>({...d,config:{...(d?.config??channel.tts??emptyConfig()),...patch},original:d?.original??channel.tts??emptyConfig(),expectedAt:d?.expectedAt??channel.updatedAt}))}
 const save=async()=>{if(!channel||!draft||busy)return;setBusy(true);setError('');setSaved(false);try{await api(`/channels/${channel.id}/tts`,{method:'POST',body:JSON.stringify({...draft.config,expectedUpdatedAt:draft.expectedAt})});await onChanged();setDraft(undefined);setSaved(true)}catch(e){setError(e instanceof Error?e.message:'语音配置保存失败')}finally{setBusy(false)}}
 return <section className="dsh-partner-tts" aria-label="TTS 渠道使用" aria-busy={busy}>
  <strong>渠道使用</strong><p className="dsh-partner-qq-hint">QQ 发送语音条；微信、Matrix、Mattermost 发送可播放或下载的音频附件。开启后由伙伴按场景决定是否使用，不会自动群发。</p>
  {!supported.length?<p>尚未添加支持语音的消息渠道，可先保存服务和试听。</p>:<>
   <label className="dsh-partner-qq-field"><span>消息渠道</span><select disabled={disabled||busy} value={channelId} onChange={e=>{if(dirty&&!window.confirm('放弃当前渠道尚未保存的语音选择？'))return;setChannelId(e.target.value);setDraft(undefined);setError('');setSaved(false)}}><option value="" disabled>请选择渠道</option>{supported.map(c=><option key={c.id} value={c.id}>{c.name} · {c.platform??'weixin'}{c.enabled?'':' · 已停用'}</option>)}</select></label>
   {channel?<>
    <label className="dsh-partner-qq-field"><span>通用 TTS</span><select disabled={disabled||busy} value={config.enabled?'on':'off'} onChange={e=>change({enabled:e.target.value==='on'})}><option value="off">不使用</option><option value="on">使用外部语音服务</option></select></label>
    {config.enabled&&<><label className="dsh-partner-qq-field"><span>语音服务</span><select disabled={disabled||busy} value={config.profileId} onChange={e=>change({profileId:e.target.value})}><option value="">请选择服务</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="dsh-partner-qq-field"><span>本渠道音色（可选）</span><input disabled={disabled||busy} value={config.voice} onChange={e=>change({voice:e.target.value})} placeholder={profiles.find(p=>p.id===config.profileId)?.voice||'留空使用服务默认音色'}/></label></>}
    {channel.platform==='qq'&&<p className="dsh-partner-qq-hint">使用通用 TTS 时优先采用此服务；关闭后是否使用 QQ 原生语音，由 QQ 设置中的开关决定。</p>}
    {dirty&&<div className="dsh-partner-qq-actions"><button disabled={disabled||busy} onClick={()=>{setDraft(undefined);setError('')}}>还原选择</button><button className="is-primary" disabled={disabled||busy||config.enabled&&!profiles.some(p=>p.id===config.profileId)} onClick={()=>void save()}>保存渠道语音</button></div>}
   </>:<p role="alert">此渠道已移除，请选择其他消息渠道。</p>}
  </>}
  {error&&<p role="alert">{error}</p>}{saved&&<p role="status">渠道语音已保存</p>}
 </section>
}
