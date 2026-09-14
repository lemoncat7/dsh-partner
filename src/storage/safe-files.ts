import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { syncDirectory } from './atomic.js'

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (e) { if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e }
}
export async function safeTree(path: string): Promise<string[]> {
  const absolute=resolve(path), ancestors:string[]=[]
  for(let p=absolute;;){ancestors.push(p);const parent=dirname(p);if(p===parent)break;p=parent}
  for(const p of ancestors.reverse()) {
    if(!await exists(p))break
    if((await lstat(p)).isSymbolicLink())throw Error('迁移路径不允许符号链接')
  }
  if(!await exists(absolute))return []
  if(process.platform==='linux') {
    const mounts=await readFile('/proc/self/mountinfo','utf8')
    for(const line of mounts.split('\n')) {
      const mount=line.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_,n:string)=>String.fromCharCode(parseInt(n,8)))
      if(mount===absolute||mount?.startsWith(absolute+sep))throw Error('迁移目录包含挂载点，需人工处理')
    }
  }
  const files:string[]=[],pending=[absolute];let count=0
  while(pending.length) {
    if(++count>100_000)throw Error('迁移目录文件过多')
    const p=pending.pop()!,stat=await lstat(p)
    if(stat.isSymbolicLink())throw Error('迁移目录包含符号链接')
    if(stat.isDirectory())for(const child of await readdir(p))pending.push(join(p,child))
    else if(stat.isFile())files.push(p)
    else throw Error('迁移目录包含特殊文件')
  }
  return files.sort()
}
export async function fileHash(path:string):Promise<string> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {const hash=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex')}finally{await file.close()}
}
export async function copyVerified(source:string,target:string):Promise<void> {
  const files=await safeTree(source)
  if(!await exists(source))return
  const directory=(await lstat(source)).isDirectory()
  if(directory){
    const directories=[source]
    while(directories.length){const current=directories.pop()!;await mkdir(join(target,current.slice(source.length)),{recursive:true,mode:0o700});for(const item of await readdir(current,{withFileTypes:true}))if(item.isDirectory())directories.push(join(current,item.name))}
  }
  for(const file of files) {
    const destination=directory?join(target,file.slice(source.length+1)):target
    await mkdir(dirname(destination),{recursive:true,mode:0o700})
    await copyFile(file,destination,constants.COPYFILE_EXCL)
    const output=await open(destination,'r+');try{await output.chmod(0o600);await output.sync()}finally{await output.close()}
    if(await fileHash(file)!==await fileHash(destination))throw Error('文件复制校验失败')
    await syncDirectory(dirname(destination))
  }
  if(directory)await syncDirectory(target)
  await syncDirectory(dirname(target))
}
export async function verifyDatabases(root:string):Promise<void> {
  for(const path of await safeTree(root)) if(path.endsWith('.sqlite')) {
    const db=new DatabaseSync(path)
    try {
      const rows=db.prepare('PRAGMA integrity_check').all()
      if(rows.length!==1||Object.values(rows[0]!)[0]!=='ok')throw Error('SQLite 完整性检查失败')
      const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      if(checkpoint&&Number(checkpoint.busy)!==0)throw Error('SQLite 仍在使用中')
    }finally{db.close()}
  }
}
