import {useState} from 'react'
import {api,type ChannelView} from '../client-api.js'
import type {QqSettings} from '../channels/qq/settings.js'

export function QqVoiceReplySettings({channel,policy,change,busy}:{channel:ChannelView;policy:QqSettings;change(patch:Partial<QqSettings>):void;busy:boolean}):JSX.Element {
 const [voices,setVoices]=useState<{id:string;name:string}[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const group=policy.replyVoiceGroupId||policy.groupIds[0]||''
 const load=async()=>{setLoading(true);setError('');try{
  const rows=await api<any[]>(`/channels/${channel.id}/qq/voices?groupId=${encodeURIComponent(group)}`)
  setVoices(rows.flatMap(r=>Array.isArray(r.characters)?r.characters.map((v:any)=>({id:v.character_id,name:v.character_name})):[]))
 }catch{setError('音色读取失败，请确认渠道在线，并先保存所选群。')}finally{setLoading(false)}}
 return <div className="dsh-partner-qq-pane">
  <p className="dsh-partner-qq-hint">聊天回复 · 所有已获访问许可的联系人均可使用，包括未归属账号。仅回复当前私聊或当前群，不开放文件读取、转发与管理操作。</p>
  <div className="dsh-partner-qq-toggle"><span><strong>允许语音回复</strong><small>伙伴按语境选择文字或语音，不强制每次使用。此开关独立于私有能力。</small></span><div><button type="button" role="switch" className="dsh-partner-switch" aria-label="允许语音回复" aria-checked={policy.replyVoiceEnabled===true} data-on={policy.replyVoiceEnabled===true} disabled={busy} onClick={()=>change({replyVoiceEnabled:!policy.replyVoiceEnabled})}><i/></button><small>{policy.replyVoiceEnabled?'已开启':'已关闭'}</small></div></div>
  <label className="dsh-partner-qq-field"><span>私聊语音的音色来源群</span><select disabled={busy||loading} value={group} onChange={e=>{change({replyVoiceGroupId:e.target.value});setVoices([])}}><option value="">请选择已接入的群</option>{policy.groupIds.map(id=><option key={id} value={id}>{id}</option>)}</select><small>QQ 音色需要通过群获取。私聊只借用音色合成，语音仍发给当前私聊用户；群聊使用当前群的音色。</small></label>
  <div className="dsh-partner-qq-actions"><button type="button" disabled={busy||loading||!group} onClick={()=>void load()}>{loading?'读取中…':'读取可用音色'}</button></div>
  <label className="dsh-partner-qq-field"><span>默认音色</span><select disabled={busy} value={policy.voiceCharacter} onChange={e=>change({voiceCharacter:e.target.value})}><option value="">使用可用音色</option>{policy.voiceCharacter&&!voices.some(v=>v.id===policy.voiceCharacter)&&<option value={policy.voiceCharacter}>已保存音色 · {policy.voiceCharacter}</option>}{voices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select><small>可在聊天时指定其他可用音色。合成失败时改用文字，不会假称已发送。</small></label>
  {error&&<p role="alert">{error}</p>}
 </div>
}
