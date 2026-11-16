import {useEffect,useRef,useState} from 'react'
import {api} from '../client-api.js'
import type {ContinuousTask} from '../continuous/domain.js'
import {errorMessage} from './workspace-components.js'
type Snapshot={tasks:Array<Omit<ContinuousTask,'seen'|'pending'>&{pendingCount:number}>;budget:number;used:number;budgetNotice:string}
type Sources={tabs:Array<{id:string;title:string;url:string}>;routes:Array<{id:string;label:string}>}
const time=(at?:number)=>at?new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'尚未'
const status=(t:Snapshot['tasks'][number])=>t.status==='stopped'?'已停止':t.status==='completed'?'已结束':t.status==='paused'?'已暂停':({waiting:'持续观察',checking:'理解新增内容',ready:'等待接话',budget:'预算保护',blocked:'需要处理'}[t.phase])
export function ContinuousPanel({companionId}:{companionId:string}):JSX.Element{
 const base='/continuous/'+encodeURIComponent(companionId)
 const [data,setData]=useState<Snapshot>(),[sources,setSources]=useState<Sources>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[adding,setAdding]=useState(false),[history,setHistory]=useState(false)
 const [form,setForm]=useState({title:'一起看文字直播',routeId:'',tabId:'',instruction:'根据新内容陪我讨论，有值得聊的再开口',until:'整场直播确认结束，或我明确说不看了',selector:''})
 const lock=useRef(false)
 const refresh=async()=>setData(await api<Snapshot>(base))
 useEffect(()=>{let disposed=false,timer:ReturnType<typeof setTimeout>;const abort=new AbortController();const poll=async()=>{try{if(!document.hidden){const next=await api<Snapshot>(base,{signal:abort.signal});if(!disposed)setData(next)}}catch(e){if(!disposed)setError(errorMessage(e))}finally{if(!disposed)timer=setTimeout(poll,5000)}};void poll();return()=>{disposed=true;abort.abort();clearTimeout(timer)}},[base])
 const run=async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();await refresh()}catch(e){setError(errorMessage(e))}finally{lock.current=false;setBusy(false)}}
 const active=data?.tasks.filter(t=>!['stopped','completed'].includes(t.status))??[],ended=data?.tasks.filter(t=>['stopped','completed'].includes(t.status))??[]
 const act=(t:Snapshot['tasks'][number],action:string)=>void run(async()=>{await api(base+'/'+encodeURIComponent(t.id)+'/action',{method:'POST',body:JSON.stringify({action,expectedRevision:t.revision})})})
 return <section className="dsh-partner-continuous" aria-label="持续任务">
  <header className="dsh-partner-continuous-heading"><div><h2>持续任务 <small>{active.length}</small></h2><p>持续观察，也会结合时间与最近的聊天自然接话。离开此页面也会继续。</p></div><button type="button" disabled={busy} onClick={()=>void run(async()=>{const s=await api<Sources>(base+'/sources');setSources(s);setForm(f=>({...f,routeId:f.routeId||s.routes[0]?.id||'',tabId:f.tabId||s.tabs[0]?.id||''}));setAdding(true)})}>添加任务</button></header>
  {error&&<p className="dsh-partner-error" role="alert">{error}</p>}
  {data&&<div className="dsh-partner-continuous-budget"><div><strong>后台预算</strong><span>过去一小时 {data.used.toLocaleString()} / {data.budget.toLocaleString()} token</span><small>包含判断与主动接话；未返回用量时计保守预留，缓存输入也计入。</small></div><label>每小时上限<select aria-label="持续任务每小时 token 预算" disabled={busy} value={data.budget} onChange={e=>void run(async()=>{await api(base+'/budget',{method:'POST',body:JSON.stringify({budget:Number(e.target.value)})})})}>{[10000,20000,40000,60000,100000,200000].map(n=><option key={n} value={n}>{n.toLocaleString()}</option>)}</select></label></div>}
  {adding&&<form className="dsh-partner-continuous-form" onSubmit={e=>{e.preventDefault();void run(async()=>{await api(base,{method:'POST',body:JSON.stringify(form)});setAdding(false)})}}>
   <label>任务名称<input required maxLength={100} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></label>
   <label>接话会话<select required value={form.routeId} onChange={e=>setForm({...form,routeId:e.target.value})}>{sources?.routes.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
   <label>已打开的网页<select required value={form.tabId} onChange={e=>setForm({...form,tabId:e.target.value})}>{sources?.tabs.map(t=><option key={t.id} value={t.id}>{t.title||t.url}</option>)}</select></label>
   <label>希望一起留意什么<textarea required maxLength={400} value={form.instruction} onChange={e=>setForm({...form,instruction:e.target.value})}/></label>
   <label>什么时候结束<input required maxLength={200} value={form.until} onChange={e=>setForm({...form,until:e.target.value})}/></label>
   <details><summary>正文区域（可选）</summary><label>CSS 选择器<input maxLength={500} placeholder="默认读取 article / main 正文" value={form.selector} onChange={e=>setForm({...form,selector:e.target.value})}/></label><p>只读取该区域文字，不分析视频或声音；网页需要自行更新正文。</p></details>
   <footer><button type="button" disabled={busy} onClick={()=>setAdding(false)}>取消</button><button disabled={busy||!form.routeId||!form.tabId}>{busy?'正在核对正文…':'开始观察'}</button></footer>
  </form>}
  {!data?<p role="status">正在读取持续任务…</p>:!active.length&&!adding?<div className="dsh-partner-continuous-empty">还没有持续任务。可以在聊天里让伙伴陪看文字直播，或选择已打开的网页开始。</div>:null}
  {[...active,...(history?ended:[])].map(t=><article key={t.id} className="dsh-partner-continuous-task" data-state={t.status}>
   <div className="dsh-partner-continuous-task-top"><div><strong>{t.title}</strong><span className="dsh-partner-continuous-status">{status(t)}</span></div>{!['stopped','completed'].includes(t.status)&&<div className="dsh-partner-continuous-actions"><button type="button" disabled={busy} onClick={()=>act(t,t.status==='paused'?'resume':'pause')}>{t.status==='paused'?'继续':'暂停'}</button><button type="button" className="is-stop" disabled={busy} onClick={()=>act(t,'stop')}>停止</button></div>}</div>
   <p>{t.reason}</p><div className="dsh-partner-continuous-metrics"><span>检查 {time(t.checkedAt)}</span><span>新内容 {time(t.changedAt)}</span><span>检查 {t.checks} 次 · 模型判断 {t.reviews} 次 · 唤起 {t.wakes} 次</span></div>
   {t.scene&&<p className="dsh-partner-continuous-scene">{t.scene}</p>}
   <details><summary>查看任务依据与来源</summary><p>{t.instruction}</p><p>结束条件：{t.until}</p><a href={t.url} target="_blank" rel="noreferrer">打开来源网页</a><p>只读到文字，不代表看过直播画面；唤起不等于已发送消息。</p></details>
  </article>)}
  {!!ended.length&&<button type="button" className="dsh-partner-continuous-history" onClick={()=>setHistory(!history)}>{history?'收起':'查看'}已结束任务（{ended.length}）</button>}
 </section>
}
