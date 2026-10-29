import {useId} from 'react'
import type {PairingView} from '../client-api.js'
import {qqGroupPeer, validQqId, type QqSettings} from '../channels/qq/settings.js'

export function QqIdentityBindingEditor({value,disabled,pairings,onChange}: {
  value:QqSettings['identityBinding']; disabled:boolean; pairings:PairingView[]; onChange(value:QqSettings['identityBinding']):void
}): JSX.Element {
  const id=useId()
  const peers=[...new Map(pairings.filter(p=>p.status==='approved').flatMap(p=>{
    const qqId=qqGroupPeer(p.userId)?.userId??p.userId
    return validQqId(qqId)?[[qqId,{qqId,name:p.displayName}] as const]:[]
  })).values()]
  return <section className="dsh-partner-qq-identity-binding" aria-label="归属账号">
    <label className="dsh-partner-qq-field"><span>归属 QQ 号</span><input value={value.enabled?value.qqId:''} inputMode="numeric" autoComplete="off" maxLength={16} list={id} disabled={disabled} placeholder="填写账号，留空关闭" onChange={e=>onChange({enabled:Boolean(e.target.value.trim()),qqId:e.target.value})}/><small>这个账号对应身份设定中的“你”。关系、称呼和相处方式直接沿用身份设定，无需重复填写。</small></label>
    <datalist id={id}>{peers.map(p=><option key={p.qqId} value={p.qqId}>{p.name}</option>)}</datalist>
    <p className="dsh-partner-qq-hint">同一账号在私聊、群聊中均适用。其他人的相处方式由人物性格与实际交往决定；联系人访问授权仍在下方单独管理。</p>
  </section>
}
