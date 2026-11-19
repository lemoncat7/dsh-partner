/** Ephemeral host-issued child authority, never inferred from headers or model arguments. */
export interface BackgroundToolScope {owner:string;audience?:'member'|'activity'|undefined;browserScope:string;authorize():void}
const scopes=new WeakMap<object,Map<string,BackgroundToolScope>>()
export function bindBackgroundScope(store:object,sessionId:string,scope:BackgroundToolScope):()=>void {
 let current=scopes.get(store);if(!current){current=new Map();scopes.set(store,current)}
 if(current.has(sessionId))throw Error('后台会话已绑定')
 current.set(sessionId,scope)
 return()=>{if(current.get(sessionId)===scope)current.delete(sessionId)}
}
export function backgroundToolScope(store:object,owner:string,sessionId:string):BackgroundToolScope|undefined {
 const scope=scopes.get(store)?.get(sessionId)
 if(scope?.owner!==owner)return
 scope.authorize()
 return scope
}
