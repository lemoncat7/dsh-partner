import {randomUUID} from 'node:crypto'
import {mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {createWriteStream} from 'node:fs'
import {BiliApiError,BiliClient,loginRequired,mediaUrl,responseJson,type BiliCredential} from './client.js'
import {openBiliMedia} from './media.js'

type Status='queued'|'running'|'draft'|'submitting'|'submitted'|'failed'|'interrupted'|'unknown'
interface Job {
  id:string;operation:string;createdAt:number;status:Status;uid:string;published:boolean
  title?:string;message?:string;bvid?:string;phase?:string;dynamic_id?:string;retryAt?:number
  meta?:Record<string,unknown>;uploaded?:{cover:string;videos:unknown[]}
}
const day=86400
const read=async<T>(path:string)=>JSON.parse(await readFile(path,'utf8')) as T
async function save(path:string,value:unknown){
  const temp=path+'.'+randomUUID()+'.tmp'
  try{await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(temp,path)}
  finally{await rm(temp,{force:true})}
}
const notSubmitted=(message:string)=>Object.assign(Error(message),{notSubmitted:true})
const channelId=/^bilibili-[A-Za-z0-9-]{1,80}$/
const jobId=/^[a-f0-9]{32}$/
const notFound=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT'
const folders=async(path:string)=>await readdir(path,{withFileTypes:true}).catch(error=>{if(notFound(error))return [];throw error})

export class BiliUploads {
  private tasks=new Map<string,{stop:AbortController;done:Promise<void>}>()
  private preparing=0
  private closing=false
  private init:Promise<void>|undefined
  constructor(private readonly root:string,private readonly client:BiliClient){}

  async close(){this.closing=true;await Promise.all([...this.tasks.keys()].map(channel=>this.cancel(channel)))}
  async cancel(channel:string){const active=this.tasks.get(channel);active?.stop.abort();await active?.done}

  async call(channel:string,operation:string,p:Record<string,unknown>,signal:AbortSignal,credential?:BiliCredential,cwd?:string,guard?:()=>void,checkChannel?:()=>void){
    if(!channelId.test(channel))throw notSubmitted('B 站渠道标识无效')
    if(!credential)throw loginRequired()
    await(this.init??=this.recover())
    if(operation==='upload_health')return {cooldown:await this.cooldown(channel)}
    if(operation==='upload_status')return this.public(await this.load(channel,p.job_id,credential.uid))
    if(operation==='publish_video')return this.publish(channel,p.draft_id,credential,signal,guard)
    if(this.closing||!cwd)throw notSubmitted('当前会话没有可用工作目录')
    return this.queue(channel,operation,p,credential,cwd,signal,guard,checkChannel)
  }

  private directory(channel:string,id:unknown){
    if(typeof id!=='string'||!jobId.test(id))throw notSubmitted('媒体任务 ID 无效')
    return join(this.root,channel,id)
  }
  private async recover(){
    for(const channel of await folders(this.root)){
      if(!channel.isDirectory()||!channelId.test(channel.name))continue
      const directory=join(this.root,channel.name)
      for(const entry of await folders(directory)){
        if(!entry.isDirectory()||!jobId.test(entry.name))continue
        const path=join(directory,entry.name,'job.json')
        let job:Job
        try{job=await read<Job>(path)}catch{continue}
        if(job.status==='queued'||job.status==='running'||job.status==='submitting'){
          job.status=job.status==='submitting'?'unknown':'interrupted'
          job.message='进程重启，未自动重发；如已提交，请先核实 B 站记录'
          await save(path,job)
        }
        await this.removeMedia(join(directory,entry.name))
      }
    }
  }

  private async load(channel:string,id:unknown,uid:string){
    const job=await read<Job>(join(this.directory(channel,id),'job.json')).catch(error=>{
      if(notFound(error))throw notSubmitted('找不到此媒体任务')
      throw error
    })
    if(job.uid!==uid)throw notSubmitted('媒体任务不属于当前账号')
    return job
  }
  private public(job:Job){
    const {meta:_meta,uploaded:_uploaded,...result}=job
    return result
  }
  private async removeMedia(directory:string){
    await Promise.all(['video','cover',...Array.from({length:9},(_,i)=>'image'+i)].map(file=>rm(join(directory,file),{force:true})))
  }
  private async cooldown(channel:string){
    const file=join(this.root,channel,'cooldown.json')
    const record=await read<{retryAt:number}>(file).catch(error=>{if(notFound(error))return {retryAt:0};throw error})
    return record.retryAt>Date.now()/1000?record:{}
  }
  private async cleanup(){
    for(const channel of await folders(this.root)){
      if(!channel.isDirectory()||!channelId.test(channel.name)||this.tasks.has(channel.name))continue
      for(const entry of await folders(join(this.root,channel.name))){
        if(!entry.isDirectory()||!jobId.test(entry.name))continue
        const directory=this.directory(channel.name,entry.name)
        const item=await stat(directory).catch(error=>{if(notFound(error))return undefined;throw error})
        if(item&&Date.now()-item.mtimeMs>7*day*1000)await rm(directory,{force:true,recursive:true})
      }
    }
  }
  private async queue(channel:string,operation:string,p:Record<string,unknown>,cred:BiliCredential,cwd:string,signal:AbortSignal,guard?:()=>void,checkChannel?:()=>void){
    if(this.tasks.has(channel)||this.tasks.size+this.preparing>=2)throw notSubmitted('已有媒体任务执行中')
    this.preparing++
    const images=operation==='image_dynamic'
    const id=randomUUID().replaceAll('-','')
    const directory=this.directory(channel,id)
    const files=images?(p.image_paths as string[]).map((file,i)=>['image'+i,file] as const):
      [['video',String(p.video_path)],['cover',String(p.cover_path)]] as const
    const job:Job={id,operation,createdAt:Date.now()/1000,status:'queued',uid:cred.uid,published:false,
      ...(!images?{title:String(p.title)}:{})}
    try{
      if(!images&&'retryAt'in await this.cooldown(channel))throw Error('B 站上传限流冷却中')
      await this.cleanup()
      await mkdir(directory,{recursive:true,mode:0o700})
      signal.throwIfAborted()
      for(const [name,raw] of files){
        const {handle,stat:before}=await openBiliMedia(cwd,raw,name==='video'?512*1024*1024:8*1024*1024)
        try{
          const signature=Buffer.alloc(16)
          const {bytesRead}=await handle.read(signature,0,signature.length,0)
          if(name!=='video')imageType(signature.subarray(0,bytesRead))
          else if(!videoExtension(signature.subarray(0,bytesRead)))throw Error('无法识别视频容器')
          await pipeline(handle.createReadStream({autoClose:false,start:0,end:before.size-1}),
            createWriteStream(join(directory,name),{flags:'wx',mode:0o600}),{signal})
          const after=await handle.stat()
          if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('文件仍在写入，请稍后重试')
        }finally{await handle.close()}
      }
      guard?.()
      if(this.closing)throw Error('伙伴正在关闭')
      await save(join(directory,'job.json'),job)
    }catch(error){
      await rm(directory,{force:true,recursive:true})
      if(signal.aborted)throw signal.reason
      throw notSubmitted(error instanceof Error?error.message:'无法准备媒体素材')
    }finally{this.preparing--}
    const stop=new AbortController()
    const done=this.run(channel,directory,job,p,cred,files.map(([name])=>name),stop.signal,checkChannel)
      .catch(()=>{}).finally(()=>this.tasks.delete(channel))
    this.tasks.set(channel,{stop,done})
    return this.public(job)
  }

  private async run(channel:string,directory:string,job:Job,p:Record<string,unknown>,cred:BiliCredential,files:string[],abort:AbortSignal,checkChannel?:()=>void){
    const path=join(directory,'job.json'),signal=AbortSignal.any([abort,AbortSignal.timeout(1800_000)])
    let submitting=false
    try{
      job.status='running';job.phase='上传素材';await save(path,job)
      checkChannel?.()
      if((await this.client.credential(channel))?.uid!==cred.uid)throw loginRequired()
      if(job.operation==='image_dynamic'){
        const pics=[]
        for(const name of files){
          const image=await readFile(join(directory,name)),type=imageType(image)
          const form=new FormData()
          form.set('file_up',new Blob([new Uint8Array(image)],{type}),name+'.'+type.split('/')[1])
          form.set('biz','new_dyn');form.set('category','daily');form.set('csrf',cred.csrf);form.set('csrf_token',cred.csrf)
          const data=await this.client.request('/x/dynamic/feed/draw/upload_bfs',signal,{cred,form})
          const width=Number(data?.image_width),height=Number(data?.image_height)
          if(!width||!height||width*height>25_000_000)throw Error('B 站返回的图片尺寸无效')
          pics.push({img_src:mediaUrl(String(data.image_url).replace(/^http:/,'https:')).href,img_width:width,img_height:height})
        }
        if((await this.client.credential(channel))?.uid!==cred.uid)throw loginRequired()
        checkChannel?.()
        job.status='submitting';job.phase='发布图片动态';await save(path,job);submitting=true
        const result=await this.client.dynamic(String(p.text??''),pics,signal,cred)
        Object.assign(job,{status:'submitted',published:true,dynamic_id:result.dynamic_id,message:'B 站已返回动态编号'})
      }else{
        job.meta={title:p.title,desc:p.description??'',tid:p.tid,tag:(p.tags as string[]).join(','),copyright:p.copyright??1,source:p.source??'',no_reprint:1,desc_format_id:0}
        const coverFile=await readFile(join(directory,'cover'))
        const cover=await this.client.request('/x/vu/web/cover/up',signal,{host:'creator',cred,form:{
          cover:'data:'+imageType(coverFile)+';base64,'+coverFile.toString('base64'),csrf:cred.csrf}})
        const coverUrl=mediaUrl(String(cover?.url??'').replace(/^http:/,'https:')).href
        const video=await this.uploadVideo(join(directory,'video'),String(p.title),cred,signal)
        Object.assign(job,{status:'draft',uploaded:{cover:coverUrl,videos:[video]},message:'素材已上传，等待明确提交投稿'})
      }
    }catch(error){
      job.status=submitting?'unknown':signal.aborted?'interrupted':'failed'
      job.message=submitting?'提交结果待核实，请勿重复发布':signal.aborted?'上传已中断':
        error instanceof Error?error.message:'媒体操作失败'
      if(!submitting&&job.operation==='upload_draft'&&error instanceof BiliApiError&&[412,429,-352,-412,-509].includes(error.code)){
        job.retryAt=Date.now()/1000+900
        await save(join(this.root,channel,'cooldown.json'),{retryAt:job.retryAt})
      }
    }finally{
      await save(path,job)
      await this.removeMedia(directory)
    }
  }

  private async uploadVideo(file:string,title:string,cred:BiliCredential,signal:AbortSignal){
    const handle=await open(file,'r')
    try{
      const head=Buffer.alloc(16)
      await handle.read(head,0,head.length,0)
      const name='partner.'+videoExtension(head)
      const {size}=await handle.stat()
      const params=new URLSearchParams({profile:'ugcfx/bup',name,size:String(size),r:'upos',ssl:'0',version:'2.14.0',build:'2100400',upcdn:'bda2',probe_version:'20221109'})
      const info=await this.client.preupload(params,cred,signal)
      const chunk=Number(info?.chunk_size),route=String(info?.upos_uri??'')
      if(info?.OK!==1||!/^upos:\/\/[\w./-]+$/.test(route)||route.includes('..')||!Number.isInteger(chunk)||chunk<1||chunk>32*1024*1024||
        typeof info?.auth!=='string'||!info.auth||typeof info?.endpoint!=='string'||!info.biz_id)throw Error('B 站预上传配置无效')
      const endpoint=mediaUrl(info.endpoint,['bilivideo.com','bilivideo.cn'])
      if(endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('B 站上传端点无效')
      const url=new URL(endpoint)
      url.pathname='/'+route.slice(7)
      const request=(method:string,values:Record<string,string>,body?:BodyInit)=>fetch(url+'?'+new URLSearchParams(values),{
        method,headers:{'x-upos-auth':info.auth,...(typeof body==='string'?{'Content-Type':'application/json'}:{})},
        ...(body!==undefined?{body}:{}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(120_000)])})
      const started=await responseJson(await request('POST',{uploads:'',output:'json',profile:'ugcfx/bup',filesize:String(size),partsize:String(chunk),biz_id:String(info.biz_id)}))
      const uploadId=started?.upload_id
      if(started?.OK!==1||typeof uploadId!=='string')throw Error('B 站未返回分片上传编号')
      const count=Math.ceil(size/chunk),parts=[]
      for(let i=0;i<count;i++){
        const start=i*chunk,end=Math.min(start+chunk,size),buffer=new Uint8Array(end-start)
        const {bytesRead}=await handle.read(buffer,0,buffer.length,start)
        if(bytesRead!==buffer.length)throw Error('读取暂存视频分片失败')
        const result=await request('PUT',{partNumber:String(i+1),uploadId,chunk:String(i),chunks:String(count),
          size:String(buffer.length),start:String(start),end:String(end),total:String(size)},buffer)
        await result.body?.cancel()
        if(!result.ok)throw new BiliApiError(result.status)
        parts.push({partNumber:i+1,eTag:'etag'})
      }
      const finished=await responseJson(await request('POST',{output:'json',name,profile:'ugcfx/bup',uploadId,biz_id:String(info.biz_id)},JSON.stringify({parts})))
      if(finished?.OK!==1)throw Error('B 站未确认视频分片上传')
      const filename=url.pathname.split('/').at(-1)?.replace(/\.[^.]+$/,'')
      if(!filename)throw Error('B 站未返回视频素材标识')
      return {filename,title,desc:'',cid:info.biz_id}
    }finally{await handle.close()}
  }

  private async publish(channel:string,id:unknown,credential:BiliCredential,signal:AbortSignal,guard?:()=>void){
    const job=await this.load(channel,id,credential.uid)
    if(job.status!=='draft'||!job.meta||!job.uploaded)throw notSubmitted('草稿未就绪或已提交，请查询原任务')
    if(Date.now()/1000-job.createdAt>7*day)throw notSubmitted('草稿已过期')
    guard?.()
    const path=join(this.directory(channel,id),'job.json')
    job.status='submitting';await save(path,job)
    try{
      guard?.()
      const result=await this.client.request('/x/vu/web/add/v3',signal,{host:'creator',cred:credential,
        params:{csrf:credential.csrf,t:Date.now()},json:{...job.meta,...job.uploaded,csrf:credential.csrf}})
      if(!/^BV[0-9A-Za-z]{10}$/.test(result?.bvid??''))throw Error('B 站未返回 BV 号')
      Object.assign(job,{status:'submitted',published:true,bvid:result.bvid,message:'稿件已提交，审核状态以 B 站为准'})
      await save(path,job)
      return this.public(job)
    }catch{
      job.status='unknown';job.message='投稿结果待核实，请勿重复提交';await save(path,job)
      throw Error(job.message)
    }
  }
}

function imageType(buffer:Buffer){
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return 'image/jpeg'
  if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return 'image/webp'
  throw Error('只支持 PNG、JPEG 或 WebP 图片')
}
function videoExtension(buffer:Buffer){
  if(buffer.toString('ascii',4,8)==='ftyp')return 'mp4'
  if(buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'mkv'
  if(buffer.toString('ascii',0,3)==='FLV')return 'flv'
}
