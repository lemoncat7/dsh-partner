import type { AffectionAdapter } from '../../character/affection-adapter.js'
import { boundQqIds, qqGroupPeer, validQqId } from './settings.js'
export const qqAffectionAdapter: AffectionAdapter={
  resolve({route,channel,autonomous}) {
    if(channel?.platform!=='qq')return undefined
    if(!channel.enabled)return false
    const group=qqGroupPeer(route.userId)
    // A proactive group activity addresses everyone; it cannot borrow an owner's identity.
    if(autonomous&&group)return false
    const id=group?.userId??route.userId
    return validQqId(id)&&boundQqIds(channel.qq?.identityBinding).includes(id)
  },
}
