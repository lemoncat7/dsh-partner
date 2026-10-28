import { useEffect, useState } from 'react'
import { api } from '../client-api.js'
import type { CharacterState } from '../character/domain.js'
import { FormField as Field } from './partner-components.js'
import { errorMessage } from './workspace-components.js'
export function CharacterMemoryEditor({ companionId }: { companionId: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [state, setState] = useState<CharacterState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState('')
  const url = `/companions/${encodeURIComponent(companionId)}/character/state${scope ? `?scopeId=${encodeURIComponent(scope)}` : ''}`
  useEffect(() => {
    if (!open) return
    let alive = true; setBusy(true); setError(undefined); setState(undefined)
    void api<{state:CharacterState;scopeId:string;scopes:string[]}>(url).then(data => { if (alive) { setState(data.state); setScopes(data.scopes) } }).catch(e => { if (alive) setError(errorMessage(e)) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [url, open])
  const save = async () => {
    if (!state || busy) return
    setBusy(true); setError(undefined); setNotice('')
    try { const data = await api<{state:CharacterState}>(url, {method:'PUT',body:JSON.stringify({state,expectedAt:state.updatedAt})}); setState(data.state); setNotice('角色记忆已保存') }
    catch(e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <details className="dsh-partner-character-preview" onToggle={e => setOpen(e.currentTarget.open)}><summary>关系与剧情记忆</summary><p className="dsh-partner-character-hint">开启学习后，随对话整理角色事实与剧情。与真实用户画像分开保存；固定记忆不会被自动改写。修改这里独立保存。</p>
    {scopes.length > 1 && <Field label="会话"><select value={scope} disabled={busy} onChange={e => {setScope(e.target.value);setNotice('')}}><option value="">本地会话</option>{scopes.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>}
    {error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}{busy && <p role="status">正在处理…</p>}
    {state && <fieldset disabled={busy} className="dsh-partner-character-fields">
      <Field label="当前场景"><textarea rows={2} maxLength={1500} value={state.scene} onChange={e => setState({...state,scene:e.target.value})}/></Field>
      <Field label="当前关系"><textarea rows={2} maxLength={1000} value={state.relationship} onChange={e => setState({...state,relationship:e.target.value})}/></Field>
      {(['facts','events','pins'] as const).map(key => <Field key={key} label={key==='facts'?'角色事实':key==='events'?'重要剧情':'固定记忆'} hint="每行一条。"><textarea rows={3} value={state[key].join('\n')} onChange={e => setState({...state,[key]:e.target.value.split('\n')})}/></Field>)}
      <div className="dsh-partner-character-row"><span role="status">{notice}</span><button type="button" onClick={() => void save()}>保存角色记忆</button></div>
    </fieldset>}
  </details>
}
