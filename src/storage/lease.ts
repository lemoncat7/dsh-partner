import { mkdir, chmod } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** OS-backed SQLite lock: another process/container cannot use the same plugin
 * data concurrently; a process crash releases it without stale PID lock files.
 */
export async function acquireStorageLease(statePath:string):Promise<()=>void> {
  const directory=dirname(resolve(statePath));await mkdir(directory,{recursive:true,mode:0o700})
  const path=join(directory,'storage-runtime.sqlite'),db=new DatabaseSync(path)
  try {await chmod(path,0o600);db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')}
  catch{db.close();throw Error('该伙伴数据目录已被另一个插件实例使用，拒绝并发运行或迁移')}
  let closed=false
  return ()=>{if(!closed){closed=true;db.close()}}
}
