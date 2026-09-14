const KEY='dsh-partner:storage-recovery'
export function pendingStorageRecovery():number|undefined {
  try{const value=JSON.parse(sessionStorage.getItem(KEY)??'null');if(value&&Number.isSafeInteger(value.target)&&value.target>0&&Date.now()-value.at<30*60_000)return value.target}catch{}
  return undefined
}
export function rememberStorageRecovery(target:number):void {try{sessionStorage.setItem(KEY,JSON.stringify({target,at:Date.now()}))}catch{}}
export function clearStorageRecovery():void {try{sessionStorage.removeItem(KEY)}catch{}}
