import {useEffect,useRef,useState} from 'react'
import {api, type MemoryView, type MemoryGraphView} from '../../client-api.js'
import {preferenceEmphasisLabel} from '../../memory-evidence.js'
import {CollectionEmpty, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {relativeTime} from '../partner-components.js'
import {MemoryDetail} from './memory-detail.js'
import {memoryKind} from './memory-cards.js'
import {MemoryGraph} from './memory-graph.js'
import {HistoryView} from './history-view.js'
import {PersonaView} from './persona-view.js'
import {ExperienceView} from './experience-view.js'
import {useMemoryResource} from './use-memory-resource.js'
import {MEMORY_STATUS, type ArtifactStatus, type MemoryCollection, type MemoryLayers, type MemoryMode} from './types.js'

const pages: ReadonlyArray<[MemoryMode,string]> = [['history','时间线'],['profile','用户画像'],['memory','记忆条目'],['scenes','场景'],['experiences','经验'],['graph','记忆关联']]

export function MemoryLibrary({companionId, scopeId, collection, layers, enabled, changed}: {
  companionId:string; scopeId:string; collection:MemoryCollection; layers:MemoryLayers|undefined; enabled:boolean; changed():Promise<void>
}): JSX.Element {
  const [mode,setMode]=useState<MemoryMode>('history')
  const [query,setQuery]=useState('')
  const [status,setStatus]=useState<MemoryView['status']|'all'>('active')
  const [kind,setKind]=useState<MemoryView['kind']|'all'>('all')
  const [emphasized,setEmphasized]=useState(false)
  const [limit,setLimit]=useState(20)
  const [inspecting,setInspecting]=useState<MemoryView>()
  const base='/companions/'+encodeURIComponent(companionId)
  const graph = useMemoryResource<MemoryGraphView>(mode === 'graph' ? base+'/memory/graph' : undefined)
  const normalized=query.trim().toLocaleLowerCase()
  const profile=collection.profiles.find(item=>item.scopeId===scopeId)
  const match=(value:string)=>!normalized||value.toLocaleLowerCase().includes(normalized)
  const filtered=collection.memories.filter(item=>item.scopeId===scopeId&&(status==='all'||item.status===status)&&
    (kind==='all'||item.kind===kind)&&(!emphasized||!!preferenceEmphasisLabel(item))&&match(item.subject+' '+item.content))
  const selectMode=(value:MemoryMode)=>{setMode(value);setQuery('');setLimit(20)}
  return <section className="dsh-partner-memory-library-v2">
    <nav className="dsh-partner-memory-nav" aria-label="记忆内容">
      {pages.map(([id,label])=><button type="button" key={id} aria-pressed={mode===id} onClick={()=>selectMode(id)}>
        {label}{id==='experiences'&&layers?.experiences.some(item=>item.status==='draft')&&
          <small>{layers?.experiences.filter(item=>item.status==='draft').length}</small>}
      </button>)}
    </nav>
    {mode==='history'&&<HistoryView key={scopeId} base={base} scopeId={scopeId}/>}
    {mode==='profile'&&<>
      <PersonaView view={profile?.persona} base={base} scopeId={scopeId} enabled={enabled} changed={changed}/>
      <ProfileFacts title="已记录的背景" entries={profile?.entries??[]} inspect={setInspecting}/>
      <ProfileFacts title="稳定偏好" entries={profile?.preferences??[]} inspect={setInspecting}/>
    </>}
    {['memory','scenes','graph'].includes(mode)&&<div className="dsh-partner-memory-toolbar">
      <label className="dsh-partner-memory-search"><span className="sr-only">搜索当前内容</span><input type="search" placeholder="搜索当前内容" value={query} onChange={event=>{setQuery(event.target.value);setLimit(20)}}/></label>
      {mode==='memory'&&<>
        <select aria-label="记忆状态" value={status} onChange={event=>{setStatus(event.target.value as typeof status);setLimit(20)}}><option value="all">全部状态</option>{Object.entries(MEMORY_STATUS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="记忆类型" value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setLimit(20)}}><option value="all">全部类型</option>{(['profile','preference','task','event','relationship','emotion'] as const).map(value=><option key={value} value={value}>{memoryKind(value)}</option>)}</select>
        <button type="button" aria-pressed={emphasized} onClick={()=>{setEmphasized(!emphasized);setLimit(20)}}>强调过</button>
      </>}
    </div>}
    {mode==='memory'&&<>
      <p className="dsh-partner-memory-hint">当前范围最近 100 条中，匹配 {filtered.length} 条。</p>
      <div className="dsh-partner-memory-rows dsh-partner-memory-list">{filtered.slice(0,limit).map(item=><button type="button" className="dsh-partner-memory-row" key={item.id} onClick={()=>setInspecting(item)}>
        <span className="dsh-partner-memory-list-kind">{memoryKind(item.kind)}</span>
        <span className="dsh-partner-memory-row-copy"><strong>{item.subject}</strong><p>{item.content}</p>{preferenceEmphasisLabel(item)&&<small className="dsh-partner-memory-emphasis">{preferenceEmphasisLabel(item)}</small>}</span>
        <small className="dsh-partner-memory-list-state">{MEMORY_STATUS[item.status]}</small>
        <time dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt)}</time>
      </button>)}</div>
      {!filtered.length&&<CollectionEmpty title="没有匹配的记忆"/>}
      {filtered.length>limit&&<button type="button" onClick={()=>setLimit(value=>value+20)}>再显示 20 条</button>}
    </>}
    {(mode==='scenes'||mode==='experiences')&&<ArtifactControls base={base} scopeId={scopeId} enabled={enabled} changed={changed}/>}
    {mode==='scenes'&&<div className="dsh-partner-memory-records">
      {layers?.scenes.filter(scene=>match(scene.title+' '+scene.summary)).map(scene=><details className="dsh-partner-memory-record" key={scene.id}>
        <summary><strong>{scene.title}</strong><small>{scene.memoryIds.length} 条有效记忆 · {relativeTime(scene.updatedAt)}</small></summary>
        <div>{scene.summary.split('\n').map((source,i)=><p key={i}>{source}</p>)}</div>
      </details>)}
      {!layers?.scenes.some(scene=>match(scene.title+' '+scene.summary))&&<CollectionEmpty title={normalized?'没有匹配的场景':'还没有场景'} {...(normalized?{}:{detail:'整理同一主题的有效记忆，点击场景可以查看原有条目。'})}/>}
    </div>}
    {mode==='experiences'&&<ExperienceView items={layers?.experiences??[]} base={base} scopeId={scopeId} changed={changed}/>}
    {mode==='graph'&&<>
      {graph.error&&<WorkspaceNotice>{graph.error} <button type="button" onClick={()=>{void graph.reload()}}>重试</button></WorkspaceNotice>}
      {graph.data?<MemoryGraph graph={{memories:graph.data.memories.filter(item=>item.scopeId===scopeId),relations:graph.data.relations.filter(item=>item.scopeId===scopeId)}} profiles={collection.profiles.filter(item=>item.scopeId===scopeId)} query={normalized} inspect={setInspecting}/>:!graph.error&&<CollectionEmpty title="正在读取关系图谱"/>}
      {!!layers?.scenes.length&&<section className="dsh-partner-memory-records">
        <h3>按共同场景查看</h3>
        {layers.scenes.filter(scene=>match(scene.title+' '+scene.summary)).map(scene=><details className="dsh-partner-memory-record" key={scene.id}>
          <summary><strong>{scene.title}</strong><small>{scene.memoryIds.length} 条记忆</small></summary>
          <div>{scene.summary.split('\n').map((item,index)=><p key={index}>{item}</p>)}</div>
        </details>)}
      </section>}
    </>}
    {inspecting&&<MemoryDetail key={inspecting.id} companionId={companionId} item={inspecting} close={()=>setInspecting(undefined)} changed={changed}/>}
  </section>
}

function ProfileFacts({title,entries,inspect}: {title:string;entries:MemoryView[];inspect(item:MemoryView):void}) {
  if(!entries.length)return null
  return <section className="dsh-partner-profile-facts"><h3>{title}</h3><div>{entries.map(item=><button type="button" key={item.id} onClick={()=>inspect(item)}>
    <strong>{item.subject}</strong><span>{item.content}</span>
    <small>{preferenceEmphasisLabel(item)||'查看依据'}</small>
  </button>)}</div></section>
}

function ArtifactControls({base,scopeId,enabled,changed}: {base:string;scopeId:string;enabled:boolean;changed():Promise<void>}) {
  const path=base+'/memory/artifacts?'+new URLSearchParams({scopeId})
  const status=useMemoryResource<ArtifactStatus>(path,5_000)
  const [starting,setStarting]=useState(false)
  const [error,setError]=useState<string>()
  const start=async()=>{
    setStarting(true);setError(undefined)
    try{await api(path,{method:'POST'});await status.reload();await changed()}
    catch(reason){setError(errorMessage(reason))}
    finally{setStarting(false)}
  }
  const value=status.data
  const refreshed=useRef<number>()
  useEffect(()=>{
    if(value?.status!=='ready'||value.at===refreshed.current)return
    refreshed.current=value.at
    void changed().catch(reason=>setError(errorMessage(reason)))
  },[value,changed])
  return <section className="dsh-partner-artifact-status">
    <div><strong>场景与经验提炼</strong><small role="status">{value?.status==='running'?'正在后台整理':value?.status==='ready'?'整理完成 · '+value.scenes+' 个场景 · '+value.experiences+' 份经验':!enabled?'学习已暂停':'开启每日终审后自动整理'}</small>
    {value?.status==='ready'&&value.experiences===0&&<small>{(value.confirmations??0)<2?'近期可核验的成功确认不足两轮':'近期未发现经过重复验证的可复用方法'}</small>}</div>
    <button type="button" disabled={!enabled||starting||value?.status==='running'} onClick={()=>{void start()}}>{starting||value?.status==='running'?'整理中…':'立即整理'}</button>
    {(error||status.error||value?.error)&&<WorkspaceNotice>{error||status.error||value?.error}</WorkspaceNotice>}
  </section>
}
