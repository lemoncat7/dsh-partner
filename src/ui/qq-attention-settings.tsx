import {QqAttentionTraining} from './qq-attention-training.js'
import {useEffect,useState} from 'react'
import {api} from '../client-api.js'
import {WorkspaceDialog,errorMessage} from './workspace-components.js'

type AttentionAction='enable'|'disable'|'reset'
type AttentionStatus={
  phase:'off'|'preparing'|'ready'|'training'|'error'
  step?:'checking'|'download'|'install'|'train'|'start'
  enabled:boolean
  usable:boolean
  custom:boolean
  model:{name:string;files:'missing'|'partial'|'present'}
  error?:string
  evaluation?:Record<string,{total:number;correct:number;training:number}>
}
const steps={checking:'正在检查模型文件',download:'正在下载模型文件',install:'正在安装推理组件',train:'正在训练和评估分类头',start:'正在启动模型'}
const modelFiles={missing:'未下载',partial:'文件不完整',present:'文件已缓存'}

function usage(status:AttentionStatus){
  if(status.usable)return status.phase==='training'?'训练完成前继续用当前模型接话。':'识别进程保持运行，已加入自主回复白名单的群可以使用。'
  if(status.phase==='preparing'||status.phase==='training')return '准备期间，群聊按已有规则接话。'
  if(status.phase==='error')return '可以重试启动本地模型。'
  if(status.model.files==='present')return '点击「开启本地识别」加载内置模型。'
  return '点击「开启本地识别」可下载并使用内置模型。'
}

export function QqAttentionSettings({channelId,groups}:{channelId:string;groups:{id:string;name:string}[]}){
  const [status,setStatus]=useState<AttentionStatus>()
  const [pending,setPending]=useState(false)
  const [showTraining,setShowTraining]=useState(false)
  const [failure,setFailure]=useState('')
  useEffect(()=>{
    let active=true,running=false
    const refresh=async()=>{
      if(running)return
      running=true
      try{const next=await api<AttentionStatus>('/qq-attention');if(active)setStatus(next)}
      catch(error){if(active)setFailure(errorMessage(error))}
      finally{running=false}
    }
    void refresh()
    const timer=setInterval(()=>void refresh(),2200)
    return()=>{active=false;clearInterval(timer)}
  },[])
  const apply=async(action:AttentionAction)=>{
    setPending(true);setFailure('')
    try{setStatus(await api<AttentionStatus>('/qq-attention',{method:'POST',body:JSON.stringify({action})}))}
    catch(error){setFailure(errorMessage(error))}
    finally{setPending(false)}
  }
  const working=status?.phase==='preparing'||status?.phase==='training'
  return <section className="dsh-partner-qq-pane" aria-label="群聊本地识别">
    <strong>群聊本地识别</strong>
    {status?<div role="status" className="dsh-partner-qq-catalog-info">
      <strong>{status.usable?'可用':working?'准备中':'不可用'}</strong>
      <span>{status.step?steps[status.step]:status.usable?(status.custom?'已训练分类头运行中':'内置分类头运行中'):status.phase==='error'?'启动或训练失败':modelFiles[status.model.files]}</span>
    </div>:<span role="status">正在读取模型状态</span>}
    {status&&<>
      <small>{status.model.name} · {modelFiles[status.model.files]}{status.model.files==='missing'?' · npm 下载约 77 MB，解包约 135 MB':''}</small>
      <p className="dsh-partner-qq-hint">{usage(status)}</p>
    </>}
    <div className="dsh-partner-qq-actions">
      {!status?.usable&&!working&&<button type="button" disabled={pending||!status} onClick={()=>void apply('enable')}>{status?.phase==='error'?'重试开启':'开启本地识别'}</button>}
      {(status?.enabled||working)&&<button type="button" disabled={pending} onClick={()=>void apply('disable')}>{working?'取消并关闭':'关闭本地识别'}</button>}
      <button type="button" disabled={!status||pending} onClick={()=>setShowTraining(true)}>训练识别模型</button>
      {status?.custom&&status.usable&&<button type="button" disabled={pending||working} onClick={()=>void apply('reset')}>恢复内置分类头</button>}
    </div>
    {showTraining&&<WorkspaceDialog title="训练识别模型" width="wide"
      detail="勾选群后，一次完成历史整理、标注和本地训练。称呼从角色设定和关系设定识别。"
      close={()=>setShowTraining(false)}>
      <QqAttentionTraining channelId={channelId} groups={groups} working={working} enabled={status?.enabled===true}/>
    </WorkspaceDialog>}
    {status?.evaluation&&<small>独立评估 {Object.values(status.evaluation).map(item=>item.correct+'/'+item.total).join(' · ')}</small>}
    {(failure||status?.error)&&<p role="alert" className="dsh-partner-qq-feedback">{failure||status?.error}</p>}
  </section>
}
