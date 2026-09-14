import { PARTNER_API } from '../client-api.js'

export interface StorageStatus { currentVersion:number; targetVersion:number; running:boolean; backupPath?:string; cleanupPending?:number; lastError?:string }
export class StorageStatusError extends Error { constructor(readonly status:number){super(status===401||status===403?'登录已失效，请重新登录后检查迁移状态':`状态请求失败（${status}）`)} }
export async function readStorageStatus(signal:AbortSignal):Promise<StorageStatus> {
  const response=await fetch(`${PARTNER_API}/storage/status`,{signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),cache:'no-store'})
  if(!response.ok)throw new StorageStatusError(response.status)
  const value=await response.json() as StorageStatus
  if(!Number.isSafeInteger(value.currentVersion)||!Number.isSafeInteger(value.targetVersion))throw Error('迁移状态响应无效')
  return value
}
function pause(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{signal.throwIfAborted();const stop=()=>{clearTimeout(timer);reject(signal.reason)};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},ms);signal.addEventListener('abort',stop,{once:true})})}
/** GET-only recovery, bounded and cancellable. Never retries the migration POST. */
export async function waitForStorage(signal:AbortSignal,onWait:()=>void,options:{read?:(signal:AbortSignal)=>Promise<StorageStatus>;delayMs?:number;attempts?:number}={}):Promise<StorageStatus>{
  const read=options.read??readStorageStatus
  for(let attempt=0;attempt<(options.attempts??60);attempt++){
    signal.throwIfAborted()
    try {const value=await read(signal);if(!value.running)return value}
    catch(error){signal.throwIfAborted();if(error instanceof StorageStatusError&&![404,408,429,502,503,504].includes(error.status))throw error}
    onWait();await pause(options.delayMs??2000,signal)
  }
  throw Error('服务尚未恢复，已停止自动检查。请稍后点击「重新连接」；不要重复提交迁移。')
}
