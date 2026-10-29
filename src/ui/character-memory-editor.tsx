import { useEffect, useState } from 'react'
import { api } from '../client-api.js'
import type { CharacterState } from '../character/domain.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

/** Shares the memory page's scope and learning switch; existing state stays in place. */
export function CharacterMemoryEditor({ companionId, scopeId, enabled, roleEnabled, onEditingChange }: {
  companionId: string; scopeId: string; enabled: boolean; roleEnabled: boolean; onEditingChange(value: boolean): void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<CharacterState>()
  const [saved, setSaved] = useState<CharacterState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const dirty = JSON.stringify(state) !== JSON.stringify(saved)
  const url = `/companions/${encodeURIComponent(companionId)}/character/state?${new URLSearchParams({scopeId})}`
  useEffect(() => { onEditingChange(dirty || busy); return () => onEditingChange(false) }, [dirty, busy, onEditingChange])
  useEffect(() => {
    if (!open || !scopeId || saved) { setBusy(false); return }
    let alive = true; setBusy(true); setError(undefined)
    void api<{state:CharacterState}>(url).then(data => { if (alive) { setState(data.state); setSaved(data.state) } })
      .catch(e => { if (alive) setError(errorMessage(e)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [url, open, revision, scopeId])
  const save = async () => {
    if (!state || busy) return
    setBusy(true); setError(undefined); setNotice('')
    try {
      const data = await api<{state:CharacterState}>(url, {method:'PUT', body:JSON.stringify({state,expectedAt:state.updatedAt})})
      setState(data.state); setSaved(data.state); setNotice('当前相处状态已保存')
    } catch(e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <details className="dsh-partner-memory-record dsh-partner-current-state" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>当前相处状态 <small>{dirty ? '有未保存的修改' : !roleEnabled ? '角色聊天未开启' : enabled ? '随记忆自动整理' : '自动整理已暂停'}</small></summary>
    <div className="dsh-partner-character">
      <p className="dsh-partner-character-hint">记住刚聊到哪、当前怎么相处。与记忆页共用上方范围和学习开关，无需再配置定时任务；上下文焕新后仍保留。真实喜好与约定在长期记忆中，梦境在“身份 → 睡眠与做梦”中查看。</p>
      {!roleEnabled && <p className="dsh-partner-character-hint">开启角色聊天后才会自动整理和使用相处状态；已有内容保留，可以继续查看和修改。</p>}
      {!enabled && <p className="dsh-partner-character-hint">记忆学习已暂停，相处状态不会自动更新。已有状态仍可用于接话，也可以在此手动修正。</p>}
      {!scopeId && <p>开始一次伙伴对话后，即可查看当前相处状态。</p>}
      {error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}
      {busy && <p role="status">正在处理…</p>}
      {state && <fieldset disabled={busy} className="dsh-partner-character-fields">
        <Field label="当前话题与场景" hint="只保留当前在聊什么、还有什么没说完。"><textarea rows={3} maxLength={1500} value={state.scene} onChange={e => setState({...state,scene:e.target.value})}/></Field>
        <Field label="当前关系" hint="明确形成的相处方式；不猜测好感值，也不覆盖人格设定。"><textarea rows={2} maxLength={1000} value={state.relationship} onChange={e => setState({...state,relationship:e.target.value})}/></Field>
        <details className="dsh-partner-settings-advanced"><summary>背景、近期互动与固定内容</summary><p className="dsh-partner-character-hint">旧的角色事实、剧情与固定记忆完整保留在这里。自动整理会合并过时状态；固定内容只由你修改。</p>
          {(['facts','events','pins'] as const).map(key => <Field key={key} label={key==='facts'?'相关角色背景':key==='events'?'近期互动':'固定内容'} hint={key==='pins'?'每行一条，最多 12 条，每条 500 字；自动整理不会改写。':'每行一条，最多 20 条，每条 300 字；不要重复长期记忆或写入梦里的经历。'}><textarea rows={3} value={state[key].join('\n')} onChange={e => setState({...state,[key]:e.target.value.split('\n')})}/></Field>)}
        </details>
        <div className="dsh-partner-character-row"><span role="status">{dirty ? '保存或撤销后可切换记忆范围。' : notice || (state.updatedAt ? `最近整理或修改：${new Date(state.updatedAt).toLocaleString()}` : '暂无相处状态，开启角色聊天与记忆学习后会自动整理。')}</span>
          {dirty && <button type="button" onClick={() => {setState(saved); setNotice('已撤销未保存修改');setError(undefined)}}>撤销修改</button>}
          <button type="button" disabled={!dirty} onClick={() => void save()}>保存相处状态</button>
        </div>
      </fieldset>}
      {scopeId && <button type="button" disabled={busy || dirty} onClick={() => {setState(undefined);setSaved(undefined);setNotice('');setRevision(n=>n+1)}}>重新读取</button>}
    </div>
  </details>
}
