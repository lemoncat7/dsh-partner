import {useEffect,useRef,useState} from 'react'
import {api} from '../client-api.js'
import type {BrowserConfig} from '../browser/domain.js'
import {errorMessage} from './workspace-components.js'

export function BrowserSettings({companionId,onChanged,onEdit}:{companionId:string;onChanged():Promise<void>;onEdit(state:{busy:boolean;dirty:boolean}):void}):JSX.Element {
  const [saved,setSaved]=useState<BrowserConfig|null>(null),[form,setForm]=useState({endpoint:'',externalUrl:'',enabled:false,autonomous:true})
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('')
  const [loaded,setLoaded]=useState(false),lock=useRef(false)
  const dirty=loaded&&(form.externalUrl!==(saved?.externalUrl??'')||form.endpoint!==(saved?.endpoint??'')||form.enabled!==(saved?.enabled??false)||form.autonomous!==(saved?.autonomous??true))
  useEffect(()=>{let live=true;api<{config:BrowserConfig|null}>(`/browser/${companionId}`).then(r=>{if(live){setSaved(r.config);setForm({endpoint:'',externalUrl:'',enabled:false,autonomous:true,...r.config});setLoaded(true)}}).catch(e=>{if(live)setError(errorMessage(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[companionId])
  useEffect(()=>{onEdit({busy:busy||loading,dirty})},[busy,loading,dirty,onEdit])
  const run=async(action:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');setFeedback('');try{await action()}catch(e){setError(errorMessage(e))}finally{lock.current=false;setBusy(false)}}
  return <form className="dsh-partner-feature-form dsh-partner-channel-form" aria-busy={busy||loading} onSubmit={e=>{e.preventDefault();void run(async()=>{
    const r=await api<{config:BrowserConfig}>(`/browser/${companionId}`,{method:'POST',body:JSON.stringify({...form,expectedUpdatedAt:saved?.updatedAt??0})});setSaved(r.config);setForm({externalUrl:'',...r.config});setFeedback('浏览器配置已保存');await onChanged()
  })}}>
    <div className="dsh-partner-browser-hint">连接现有 Chrome / Chromium，多个消息渠道共用。浏览器属于公开能力，已授权聊天与自主活动可使用其中的网页和登录状态。</div>
    {loading&&<div role="status" className="dsh-partner-browser-hint">正在加载配置…</div>}
    <label className="dsh-partner-channel-field"><span>CDP 地址</span><input aria-label="CDP 地址" autoFocus disabled={!loaded||busy} required type="url" maxLength={2048} placeholder="http://chromium:9222" value={form.endpoint} onChange={e=>{setForm({...form,endpoint:e.target.value});setFeedback('')}}/><small>填写 DSH 服务端可访问的调试地址；支持 HTTP 地址或浏览器 WebSocket 地址。不要填写远程桌面的 3000 / 3001 端口。</small></label>
    <label className="dsh-partner-channel-field"><span>外部访问地址（可选）</span><input aria-label="外部访问地址" aria-describedby="partner-browser-external-help" disabled={!loaded||busy} type="url" maxLength={2048} placeholder="https://chrome.example.com" value={form.externalUrl} onChange={e=>{setForm({...form,externalUrl:e.target.value});setFeedback('')}}/><small id="partner-browser-external-help">填写你能打开的远程浏览器页面。遇到无法自行完成的登录或验证时，伙伴可在归属私聊或本地会话把此链接和待处理页面发给你；不会替换上面的 CDP 地址。</small></label>
    <label className="dsh-partner-channel-field"><span>公开能力</span><select aria-label="公开能力" disabled={!loaded||busy} value={form.enabled?'on':'off'} onChange={e=>setForm({...form,enabled:e.target.value==='on'})}><option value="off">关闭</option><option value="on">开启浏览器操作</option></select></label>
    <label className="dsh-partner-channel-field"><span>自主活动</span><select aria-label="自主活动" disabled={!loaded||busy||!form.enabled} value={form.autonomous?'on':'off'} onChange={e=>setForm({...form,autonomous:e.target.value==='on'})}><option value="on">允许自行浏览与互动</option><option value="off">仅聊天中使用</option></select><small>沿用现有自主活动调度，由伙伴决定是否使用浏览器，不新增定时轮询。</small></label>
    {error&&<p role="alert">{error}</p>}{feedback&&<div role="status" className="dsh-partner-browser-success">{feedback}</div>}
    <footer><button type="button" disabled={!loaded||busy||!form.endpoint.trim()} onClick={()=>void run(async()=>{const r=await api<{browser:string;protocol:string}>(`/browser/${companionId}/test`,{method:'POST',body:JSON.stringify({endpoint:form.endpoint})});setFeedback(`连接成功 · ${r.browser} · CDP ${r.protocol}，${dirty?'当前配置尚未保存':'配置已保存'}`)})}>{busy?'处理中…':'测试连接'}</button><button className="is-primary" disabled={!loaded||busy||!dirty||!form.endpoint.trim()}>保存</button></footer>
  </form>
}
