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
  return <section className="dsh-partner-qq-identity-binding" aria-label="身份关系绑定">
    <div className="dsh-partner-qq-toggle"><span><strong>身份关系绑定</strong><small>指定哪个 QQ 号对应人设中的关系。人物性格、说话方式和工具能力保持原设定。</small></span><div><button type="button" role="switch" className="dsh-partner-switch" aria-label="启用身份关系绑定" aria-checked={value.enabled} data-on={value.enabled} disabled={disabled} onClick={()=>onChange({...value,enabled:!value.enabled})}><i aria-hidden="true"/></button><small>{value.enabled?'已开启':'未开启'}</small></div></div>
    {value.enabled&&<div className="dsh-partner-qq-binding-fields">
      <label className="dsh-partner-qq-field"><span>主归属 QQ 号</span><input value={value.qqId} inputMode="numeric" autoComplete="off" maxLength={16} list={id} disabled={disabled} placeholder="填写对应人的 QQ 号" onChange={e=>onChange({...value,qqId:e.target.value})}/><small>私聊和群聊均按实际发言账号识别，不按昵称或自称判断。</small></label>
      <datalist id={id}>{peers.map(p=><option key={p.qqId} value={p.qqId}>{p.name}</option>)}</datalist>
      <label className="dsh-partner-qq-field"><span>人设中的关系</span><input value={value.relationship} maxLength={40} disabled={disabled} placeholder="例如：哥哥、姐姐、挚友" onChange={e=>onChange({...value,relationship:e.target.value})}/><small>填写这个人相对于角色的身份。例如角色是弟弟，这里填写“哥哥”。</small></label>
      <p className="dsh-partner-qq-hint">绑定后，只有这个账号对应这层人设关系。其他人从初识或已有交往继续相处，具体态度由人物性格决定，不额外要求冷淡或亲近。</p>
    </div>}
    <p className="dsh-partner-qq-hint">绑定不等于批准访问，也不决定是否共用主会话。下方联系人授权仍单独管理；关闭绑定后恢复原有人设解释，已填写内容保留。</p>
  </section>
}
