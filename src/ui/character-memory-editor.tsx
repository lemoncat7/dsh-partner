import { useEffect, useRef, useState } from 'react'
import { api } from '../client-api.js'
import type { CharacterState } from '../character/domain.js'
import { FormField as Field, relativeTime } from './partner-components.js'
import { errorMessage, WorkspaceDialog, WorkspaceNotice } from './workspace-components.js'
import { useMemoryResource } from './memory/use-memory-resource.js'

const groups = [
  {key:'facts', label:'相处背景'},
  {key:'events', label:'近期互动'},
] as const

export function CharacterMemoryEditor({companionId,scopeId,enabled,roleEnabled,onEditingChange}: {
  companionId:string; scopeId:string; enabled:boolean; roleEnabled:boolean; onEditingChange(value:boolean):void
}):JSX.Element {
  const url='/companions/'+encodeURIComponent(companionId)+'/character/state?'+new URLSearchParams({scopeId})
  const resource=useMemoryResource<{state:CharacterState}>(scopeId?url:undefined,15_000)
  const [draft,setDraft]=useState<CharacterState>()
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState<string>()
  const [notice,setNotice]=useState<string>()
  const initialField=useRef<'scene'|'pins'>('scene')
  const editing=!!draft
  const state=resource.data?.state
  useEffect(()=>{onEditingChange(editing);return()=>onEditingChange(false)},[editing,onEditingChange])
  const openEditor=(field:'scene'|'pins')=>{
    if(!state)return
    initialField.current=field
    setError(undefined);setNotice(undefined);setDraft(state)
  }
  const save=async()=>{
    if(!draft||busy)return
    setBusy(true);setError(undefined)
    try{
      await api(url,{method:'PUT',body:JSON.stringify({state:draft,expectedAt:draft.updatedAt})})
      setDraft(undefined);setNotice('已保存');await resource.reload()
    }catch(reason){setError(errorMessage(reason))}
    finally{setBusy(false)}
  }
  return <section className="dsh-partner-companion-state" aria-label="当前相处状态">
    <header>
      <div><h3>当前相处状态</h3><small>{notice??(state?.updatedAt?relativeTime(state.updatedAt)+'更新':!scopeId?'开始对话后可查看':resource.loading?'正在读取':!roleEnabled?'角色聊天已关闭':!enabled?'学习已暂停':'等待对话整理')}</small></div>
      <button type="button" disabled={!state} onClick={()=>openEditor('scene')}>编辑相处状态</button>
    </header>
    {resource.error&&<WorkspaceNotice>{resource.error} <button type="button" onClick={()=>{void resource.reload()}}>重试</button></WorkspaceNotice>}
    {state&&<>
      <div className="dsh-partner-state-overview">
        <div><h4>聊到哪儿了</h4><p>{state.scene||'暂无接续话题'}</p></div>
        <div><h4>目前怎么相处</h4><p>{state.relationship||'暂无相处记录'}</p></div>
      </div>
      <section className="dsh-partner-state-pins" aria-label="手动保留">
        <div>
          <h4>手动保留</h4>
          {state.pins.length>0
            ? <ul>{state.pins.map((item,index)=><li key={index}>{item}</li>)}</ul>
            : <p>还没有添加。可以保留希望伙伴记住的约定或偏好。</p>}
        </div>
        <button type="button" onClick={()=>openEditor('pins')}>{state.pins.length?'编辑保留内容':'添加保留内容'}</button>
      </section>
      {groups.some(({key})=>state[key].length>0)&&<details className="dsh-partner-state-extra"><summary>查看背景和近期互动</summary><div>
        {groups.filter(({key})=>state[key].length>0).map(({key,label})=><section key={key}><h4>{label}</h4><ul>{state[key].map((item,index)=><li key={index}>{item}</li>)}</ul></section>)}
      </div></details>}
    </>}
    {draft&&<WorkspaceDialog eyebrow="" title="编辑相处状态" detail="角色聊天开启时，伙伴会在当前记忆范围的私下对话中参考这些内容。" className="dsh-partner-state-dialog" close={()=>{if(!busy)setDraft(undefined)}}>
      <form className="dsh-partner-state-form" onSubmit={event=>{event.preventDefault();void save()}}>
        {error&&<WorkspaceNotice>{error}</WorkspaceNotice>}
        <div className="dsh-partner-state-fields">
          <Field label="聊到哪儿了"><textarea rows={4} maxLength={1500} value={draft.scene} data-dialog-initial-focus={initialField.current==='scene'?true:undefined} onChange={event=>setDraft({...draft,scene:event.target.value})}/></Field>
          <Field label="目前怎么相处"><textarea rows={4} maxLength={1000} value={draft.relationship} onChange={event=>setDraft({...draft,relationship:event.target.value})}/></Field>
        </div>
        <div className="dsh-partner-state-pin-editor">
          <Field label="手动保留" hint="每行一条，最多 12 条，每条 500 字">
            <textarea rows={3} value={draft.pins.join('\n')} data-dialog-initial-focus={initialField.current==='pins'?true:undefined} placeholder="例如：工作日上午有空再回消息，不用主动提醒我。" onChange={event=>setDraft({...draft,pins:event.target.value.split('\n')})}/>
          </Field>
          <p>由你手动添加，伙伴整理对话时会保留这些条目。</p>
        </div>
        <details className="dsh-partner-state-extra-editor">
          <summary>相处背景与近期互动</summary>
          <div className="dsh-partner-state-fields">{groups.map(({key,label})=><Field key={key} label={label} hint="每行一条，最多 20 条，每条 300 字">
            <textarea rows={3} value={draft[key].join('\n')} onChange={event=>setDraft({...draft,[key]:event.target.value.split('\n')})}/>
          </Field>)}</div>
        </details>
        <footer className="dsh-partner-memory-actions">
          <button type="button" disabled={busy} onClick={()=>setDraft(undefined)}>取消</button>
          {error&&<button type="button" disabled={busy} onClick={()=>{void resource.reload();setDraft(undefined)}}>读取最新状态</button>}
          <button type="submit" className="is-primary" disabled={busy}>{busy?'保存中…':'保存'}</button>
        </footer>
      </form>
    </WorkspaceDialog>}
  </section>
}
