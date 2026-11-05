import {open,realpath} from 'node:fs/promises'
import {constants,type Stats} from 'node:fs'
import {resolve,relative,isAbsolute} from 'node:path'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
const limit=512*1024*1024
async function connection(){return {url:process.env.PARTNER_BILIBILI_URL??'http://dsh-bilibili:8091',token:(await readFile(process.env.PARTNER_BILIBILI_TOKEN_FILE??'/data/partner/bilibili-bridge-token','utf8')).trim()}}
function inside(root:string,path:string){const rel=relative(root,path);return !!rel&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.split('/').some(x=>x.startsWith('.'))}
export async function openBiliMedia(cwd:string,path:string,max=limit){
 const root=await realpath(cwd),file=await realpath(resolve(root,path))
 if(!inside(root,file))throw Error('媒体文件必须位于当前会话目录内，不能读取隐藏文件')
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try {const stat=await handle.stat();if(!stat.isFile()||!stat.size||stat.size>max||!inside(root,await realpath(`/proc/self/fd/${handle.fd}`)))throw Error('媒体文件无效或超出大小限制');return {handle,stat}}catch(e){await handle.close();throw e}
}
export async function stageBiliMedia(channel:string,cwd:string,p:Record<string,unknown>,signal:AbortSignal,images=false){
 const files=[] as Array<{name:string;handle:Awaited<ReturnType<typeof open>>;stat:Stats}>
 try {
  if(images){if(!Array.isArray(p.image_paths)||!p.image_paths.length||p.image_paths.length>9)throw Error('漫画图片须为1–9张');for(const [i,path] of p.image_paths.entries())files.push({name:'image'+i,...await openBiliMedia(cwd,String(path),8*1024*1024)})}
  else{files.push({name:'video',...await openBiliMedia(cwd,String(p.video_path))});files.push({name:'cover',...await openBiliMedia(cwd,String(p.cover_path),8*1024*1024)})}
  const {url,token}=await connection(),boundary='bili-'+randomUUID()
  async function* body(){for(const f of files){yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);let pos=0;const buf=Buffer.alloc(65536);while(pos<f.stat.size){signal.throwIfAborted();const r=await f.handle.read(buf,0,Math.min(buf.length,f.stat.size-pos),pos);if(!r.bytesRead)throw Error('媒体文件读取中断');pos+=r.bytesRead;yield Buffer.from(buf.subarray(0,r.bytesRead))}const after=await f.handle.stat();if(after.size!==f.stat.size||after.mtimeMs!==f.stat.mtimeMs)throw Error('文件仍在写入，请完成后重试');yield Buffer.from('\r\n')}yield Buffer.from(`--${boundary}--\r\n`)}
  const response=await fetch(url+(images?'/stage-images/':'/stage/')+encodeURIComponent(channel),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'multipart/form-data; boundary='+boundary},body:body() as unknown as BodyInit,duplex:'half',signal:AbortSignal.any([signal,AbortSignal.timeout(300000)])} as RequestInit&{duplex:string})
  const r=await response.json() as {stageId?:string;error?:string};if(!response.ok||!r.stageId)throw Error(r.error??'素材传输失败')
  const {video_path,cover_path,image_paths,...meta}=p;return {...meta,stageId:r.stageId}
 }finally{await Promise.all(files.map(f=>f.handle.close()))}
}
