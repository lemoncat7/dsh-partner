import type { ChannelSession, WeixinChannel } from '../domain.js'
import { qqAffectionAdapter } from '../channels/qq/affection-adapter.js'
export interface AffectionAudience { route: ChannelSession; channel?: WeixinChannel; autonomous?: boolean }
export interface AffectionAdapter { resolve(audience: AffectionAudience): boolean | undefined }
/** Default channels participate; QQ supplies its own verified-account restriction. */
export const defaultAffectionAdapter: AffectionAdapter={resolve:()=>true}
const adapters:readonly AffectionAdapter[]=[qqAffectionAdapter]
export function affectionAudienceAllowed(audience: AffectionAudience): boolean {
  for(const adapter of adapters){const result=adapter.resolve(audience);if(result!==undefined)return result}
  return defaultAffectionAdapter.resolve(audience)===true
}
