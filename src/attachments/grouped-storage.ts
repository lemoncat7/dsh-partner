import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentDelivery } from './service.js'

export function attachmentOwnerDirectory(root:string,owner:string):string{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(owner))throw Error('附件所属伙伴编号无效')
  return join(root,owner)
}

/** One shared index, owner-scoped files. Startup-only, resumable and no overwrites. */
export async function groupAttachmentFiles(root:string,items:AttachmentDelivery[]):Promise<void>{
  for(const item of items){
    if(!/^[a-f0-9]{64}$/.test(item.id))throw Error('附件索引无效')
    const directory=attachmentOwnerDirectory(root,item.companionId)
    await mkdir(directory,{recursive:true,mode:0o700})
    if(!(await lstat(directory)).isDirectory())throw Error('附件目录不是普通目录')
    const source=join(root,item.id),target=join(directory,item.id)
    const old=await lstat(source).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined})
    const current=await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined})
    const verify=async(path:string)=>{
      if(!(await lstat(path)).isFile())throw Error('附件不是普通文件')
      const data=await readFile(path)
      if(data.length!==item.size||createHash('sha256').update(data).digest('hex')!==item.hash)throw Error('附件分目录迁移校验失败，已保留源文件')
    }
    if(current){
      if(!current.isFile())throw Error('附件不是普通文件')
      if(old){await verify(source);await verify(target);await unlink(source)}
    }else if(old){await verify(source);await rename(source,target)}
    else throw Error('附件副本缺失，无法完成分目录迁移')
  }
}
