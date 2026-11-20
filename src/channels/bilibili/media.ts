import {open,realpath,lstat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {resolve,relative,isAbsolute,sep} from 'node:path'
const limit=512*1024*1024
function inside(root:string,path:string){const rel=relative(root,path);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)&&!rel.split(sep).some(x=>x.startsWith('.'))}
export async function openBiliMedia(cwd:string,path:string,max=limit){
 const root=await realpath(cwd),file=await realpath(resolve(root,path))
 if(!inside(root,file))throw Error('媒体文件必须位于当前会话目录内，不能读取隐藏文件')
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try {const stat=await handle.stat();if(!stat.isFile()||!stat.size||stat.size>max||!(await sameOpenedFile(root,file,handle.fd,stat)))throw Error('媒体文件无效或超出大小限制');return {handle,stat}}catch(e){await handle.close();throw e}
}
async function sameOpenedFile(root:string,file:string,fd:number,stat:{dev:number;ino:number}){
 if(process.platform==='linux')return inside(root,await realpath(`/proc/self/fd/${fd}`))
 const actual=await realpath(file)
 const current=await lstat(actual)
 return inside(root,actual)&&current.isFile()&&current.dev===stat.dev&&current.ino===stat.ino
}
