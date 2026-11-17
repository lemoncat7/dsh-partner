import type {Companion, PartnerState} from '../domain.js'
import type {PartnerStore} from '../store.js'

/** Role-chat features are one bundle, resolved before tools, prompts or guards. */
const ROLE_TOOLS=new Set(['partner_chat_reply','partner_chat_say','partner_chat_progress','partner_stickers','partner_background_task','partner_affection','partner_thoughts','partner_habits','partner_sleep','partner_activity_finish','partner_agreement'])
export interface CompanionRuntimePolicy {
 readonly roleChat:boolean
 readonly rules:Readonly<{taskPreamble:boolean;completionRecovery:boolean;forceBackground:boolean;personaDelivery:boolean;autoChildCleanup:boolean}>
 readonly companion:Companion
 allowsTool(name:string):boolean
}
export function roleChatPolicy(source:Pick<Companion,'characterCard'>){
 const roleChat=source.characterCard?.enabled===true
 return {roleChat,rules:Object.freeze({taskPreamble:roleChat,completionRecovery:roleChat,forceBackground:roleChat,personaDelivery:roleChat,autoChildCleanup:roleChat})}
}
export function projectRuntimeCompanion(source:Companion,roleChat:boolean):Companion {
 let companion=source
 if(!roleChat){
  companion={...source,automation:{...source.automation,memory:{...source.automation?.memory,rollingContextEnabled:false}},sleepPolicy:{enabled:false,dreamsEnabled:false},...(source.idleContact?{idleContact:{...source.idleContact,enabled:false}}:{})}
  // Stored settings remain intact. A runtime projection must not revive old options.
  delete companion.characterCard
  delete companion.relationshipText
  delete companion.activityInterest
  delete companion.activityPlan
 }
 return companion
}
export function resolveCompanionRuntimePolicy(source:Companion):CompanionRuntimePolicy {
 const {roleChat,rules}=roleChatPolicy(source)
 return Object.freeze({roleChat,rules,companion:projectRuntimeCompanion(source,roleChat),allowsTool:(name:string)=>roleChat||!ROLE_TOOLS.has(name)})
}
/** Real stores compile at commit time; fixtures may resolve from their own current state. */
export function runtimePolicy(store:Pick<PartnerStore,'snapshot'> & Partial<Pick<PartnerStore,'runtimePolicy'>>,owner:string):CompanionRuntimePolicy|undefined {
 if(store.runtimePolicy)return store.runtimePolicy(owner)
 if(typeof store.snapshot!=='function')return
 const c=(store.snapshot().companions??[]).find(c=>c.id===owner)
 return c?resolveCompanionRuntimePolicy(c):undefined
}
export function runtimeState(state:PartnerState,policyFor?:(id:string)=>CompanionRuntimePolicy|undefined):PartnerState {
 return {...state,companions:state.companions.map(c=>projectRuntimeCompanion(c,policyFor?policyFor(c.id)?.roleChat??false:roleChatPolicy(c).roleChat))}
}
export function runtimeSnapshot(store:PartnerStore):PartnerState {
 const state=store.snapshot()
 if(!state.companions)return state
 return {...state,companions:state.companions.map(c=>projectRuntimeCompanion(c,runtimePolicy(store,c.id)?.roleChat??false))}
}

export function runtimeSessionPolicy(store:PartnerStore,sessionId:string):CompanionRuntimePolicy|undefined {
 if(typeof store.runtimePolicyForSession==='function')return store.runtimePolicyForSession(sessionId)
 const route=store.snapshot().sessions?.find(r=>r.sessionId===sessionId)
 return route?runtimePolicy(store,route.companionId):undefined
}
