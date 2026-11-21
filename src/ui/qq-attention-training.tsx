import {useEffect,useState} from 'react'
import {api} from '../client-api.js'
import {errorMessage} from './workspace-components.js'

type Score={total:number;correct:number;baseline:number;training:number}
type ProfileCounts={roleAliases:number;roleScenes:number;relationshipAliases:number;relationshipScenes:number}
type SceneCoverage={scene:string;training:number;holdout:number}[]
type BatchView={
 job?:{phase:'extracting'|'profile'|'history'|'labeling'|'training'|'done'|'error'|'cancelled';groups:number;samples?:number;personaSamples?:number;profile?:ProfileCounts;sceneCoverage?:SceneCoverage;history?:'applied'|'skipped'|'rejected';warning?:string;error?:string}
 busy:boolean
 canReset:boolean
 defaultProfile?:ProfileCounts
 defaultEvaluation?:{intent?:Score;scene?:Score}
 versions:{id:string;createdAt:number;current:boolean;profile?:ProfileCounts;sceneCoverage?:SceneCoverage;persona?:{calls:Score;nonCalls?:Score;scenes?:Score;relationshipAliases:number}}[]
}
const phases={extracting:'AI 正在提取角色与关系设定',profile:'正在训练角色与关系特征',history:'正在读取所选群的历史',labeling:'AI 正在标注历史样本',training:'正在本地训练和评估',
 done:'设定训练完成',error:'训练未完成',cancelled:'已取消'}
const sceneNames:Record<string,string>={address:'呼唤',question:'求助与追问',banter:'接梗与吐槽',share:'分享',topic:'抛话题',close:'收尾',other:'群友之间接话',background:'群聊背景'}

export function QqAttentionTraining({channelId,groups,working,enabled}:{channelId:string;groups:{id:string;name:string}[];working:boolean;enabled:boolean}){
 const [selected,setSelected]=useState<string[]>([])
 const [days,setDays]=useState(3)
 const [view,setView]=useState<BatchView>()
 const [pending,setPending]=useState(false)
 const [failure,setFailure]=useState('')
 const ids=groups.filter(group=>selected.includes(group.id)).map(group=>group.id)
 const path='/qq-attention/'+encodeURIComponent(channelId)
 const query=new URLSearchParams(ids.map(id=>['group',id])).toString()

 useEffect(()=>{
  const ctrl=new AbortController()
  let requesting=false
  const refresh=async()=>{
   if(requesting)return
   requesting=true
   try{const value=await api<BatchView>(path+(query?'?'+query:''),{signal:ctrl.signal})
    if(!ctrl.signal.aborted)setView(value)
   }catch(error){if(!ctrl.signal.aborted)setFailure(errorMessage(error))}
   finally{requesting=false}
  }
  void refresh()
  const timer=setInterval(()=>void refresh(),2500)
  return()=>{clearInterval(timer);ctrl.abort()}
 },[path,query])

 const run=async(action:'train'|'cancel'|'reset'|'restore-version',version?:string)=>{
  if(pending)return
  setPending(true);setFailure('')
  try{
   const payload={action,groupIds:ids,...(action==='train'?{days,confirm:true}:{}),...(version?{version}:{})}
   setView(await api<BatchView>(path,{method:'POST',body:JSON.stringify(payload)}))
  }catch(error){setFailure(errorMessage(error))}
  finally{setPending(false)}
 }
 const busy=pending||view?.busy===true
 const job=view?.job
 const current=view?.versions.find(version=>version.current)
 const persona=current?.persona
 const profile=ids.length?current?.profile??view?.defaultProfile:view?.defaultProfile
 const coverage=job?.sceneCoverage??current?.sceneCoverage
 const status=job?.phase==='done'?(job.groups===0?'设定与默认分类头已训练并启用':job.history==='applied'?'设定与群历史已训练并启用':phases.done):
  job?.phase==='profile'&&job.groups===0?'正在训练设定与默认分类头':job?phases[job.phase]:undefined
 return <div className="dsh-partner-qq-pane">
  {groups.length>0&&
   <fieldset className="dsh-partner-qq-options"><legend>选择训练用的群</legend>
    {groups.map(item=><label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy}
     onChange={event=>{
      const checked=event.currentTarget.checked
      setFailure('')
      setSelected(ids=>checked?[...ids,item.id]:ids.filter(id=>id!==item.id))
     }}/>
     <span>{item.name}</span></label>)}
   </fieldset>}
   {ids.length>0&&<label>历史范围 <select value={days} disabled={busy} onChange={event=>setDays(Number(event.target.value))}>
    <option value={1}>近 1 天</option><option value={3}>近 3 天</option><option value={7}>近 7 天</option>
   </select></label>}
   <p className="dsh-partner-qq-hint">{ids.length?'先训练角色与关系设定，再用所选群的历史训练场景。':'本次会训练角色设定、关系设定和默认分类头。勾选群后可训练群历史。'}
    使用云端模型时，设定{ids.length?'和精选历史':''}会交给已配置的模型。</p>
   {!enabled&&<p className="dsh-partner-qq-hint">通过评估后会启用本地识别。</p>}
   <div className="dsh-partner-qq-actions">
    {view?.busy?<button type="button" disabled={pending} onClick={()=>void run('cancel')}>取消训练</button>:
     <button type="button" disabled={busy||working} onClick={()=>void run('train')}>{ids.length?'一键训练':'训练默认模型'}</button>}
    {ids.length>0&&view?.canReset&&<button type="button" disabled={busy||working} onClick={()=>void run('reset')}>所选群使用默认分类头</button>}
   </div>
   {ids.length>0&&!!view?.versions.length&&<label>共同训练版本 <select disabled={busy||working}
    value={current?.id??''}
    onChange={event=>{if(event.target.value)void run('restore-version',event.target.value)}}>
    <option value="" disabled>选择版本</option>
    {view.versions.map(version=><option key={version.id} value={version.id}>
     {version.createdAt?new Date(version.createdAt).toLocaleString():'之前训练的版本'}
    </option>)}
   </select></label>}
  {job&&<p role="status">{status}{job.groups>0&&` · ${job.groups} 个群`}{job.samples?` · ${job.samples} 条精选历史`:''}
   {job.personaSamples!==undefined&&` · ${job.personaSamples} 条历史称呼样本参与训练`}</p>}
  {profile&&<div className="dsh-partner-qq-hint">
   <div>角色设定 · {profile.roleAliases} 个称呼 · {profile.roleScenes} 个场景</div>
   <div>关系设定 · {profile.relationshipAliases} 个称呼 · {profile.relationshipScenes} 个场景</div>
  </div>}
  {!ids.length&&view?.defaultEvaluation?.scene&&<div className="dsh-partner-qq-hint">
   默认场景评估 {view.defaultEvaluation.scene.correct}/{view.defaultEvaluation.scene.total}
  </div>}
  {job?.warning&&<p role="status" className="dsh-partner-qq-hint">群历史训练 · {job.warning}</p>}
  {!!coverage?.length&&<div className="dsh-partner-qq-hint">
   <div>群历史场景覆盖（训练 / 留出）</div>
   <div>{coverage.map(({scene,training,holdout})=>`${sceneNames[scene]??scene} ${training} / ${holdout}`).join(' · ')}</div>
  </div>}
  {ids.length>0&&persona&&<div className="dsh-partner-qq-hint">
   <div>当前群历史分类头 · 称呼样本 {persona.calls.training} 条 · 从历史确认的关系称呼 {persona.relationshipAliases} 个</div>
   <div>{persona.calls.total?`呼唤识别 ${persona.calls.baseline}/${persona.calls.total} → ${persona.calls.correct}/${persona.calls.total}`:'缺少留出的称呼样本'}</div>
   {persona.nonCalls&&persona.nonCalls.total>0&&<div>排除提及或指向他人 {persona.nonCalls.baseline}/{persona.nonCalls.total} → {persona.nonCalls.correct}/{persona.nonCalls.total}</div>}
   {persona.scenes&&<div>设定相关场景训练 {persona.scenes.training} 条 · {persona.scenes.total?`留出评估 ${persona.scenes.baseline}/${persona.scenes.total} → ${persona.scenes.correct}/${persona.scenes.total}`:'缺少留出样本'}</div>}
  </div>}
  {(failure||job?.error)&&<p role="alert" className="dsh-partner-qq-feedback">{failure||job?.error}</p>}
 </div>
}
