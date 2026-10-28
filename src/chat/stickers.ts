import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILTIN_STICKERS } from './sticker-builtins.js'

export interface Sticker { id: string; name: string; tags: string[]; mediaType: string; size: number; builtin?: boolean }
const LIMIT = 2 * 1024 * 1024
/** Only raster formats. Never trust an uploaded extension or browser-supplied MIME. */
export function stickerMediaType(bytes: Buffer): string {
  if (!bytes.length || bytes.length > LIMIT) throw new Error('表情图片须在 2 MB 以内')
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16)==='IHDR') {
    if (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16)>2048 || bytes.readUInt32BE(20)>2048) throw new Error('PNG 尺寸须在 2048 × 2048 以内')
    return 'image/png'
  }
  if (bytes.length >= 10 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) {
    if (!bytes.readUInt16LE(6) || !bytes.readUInt16LE(8) || bytes.readUInt16LE(6)>2048 || bytes.readUInt16LE(8)>2048) throw new Error('GIF 尺寸须在 2048 × 2048 以内')
    return 'image/gif'
  }
  if (bytes.length >= 12 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes.at(-2)===255 && bytes.at(-1)===217) return 'image/jpeg'
  if (bytes.length >= 20 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP' && bytes.readUInt32LE(4)+8===bytes.length) return 'image/webp'
  throw new Error('只支持 PNG、JPEG、GIF、WebP 图片，不接受 SVG 或网页')
}
/** Each companion owns an independent atomic catalogue. No remote URL fetching. */
export class StickerLibrary {
  private queues = new Map<string,Promise<unknown>>()
  constructor(private root: (owner:string)=>string) {}
  private directory(owner:string) { if (!/^[\w-]+$/.test(owner)) throw new Error('伙伴标识无效'); return join(this.root(owner),'stickers') }
  async serial<T>(owner:string,work:()=>Promise<T>):Promise<T> {
    const job=(this.queues.get(owner)??Promise.resolve()).catch(()=>{}).then(work)
    this.queues.set(owner,job)
    try{return await job}finally{if(this.queues.get(owner)===job)this.queues.delete(owner)}
  }
  async list(owner:string,query=''):Promise<Sticker[]> {
    const custom = await this.custom(owner)
    const q=query.trim().normalize('NFKC').toLowerCase()
    const terms=q.split(/[\s,，、;；]+/).filter(Boolean)
    return [...BUILTIN_STICKERS.map(({data,...item})=>({...item,builtin:true})),...custom]
      .map(item=>({item,score:terms.reduce((n,term)=>n+([item.name,...item.tags].some(tag=>{const t=tag.normalize('NFKC').toLowerCase();return t.includes(term)||(t.length>1&&term.includes(t))})?1:0),0)}))
      .filter(entry=>!terms.length||entry.score>0).sort((a,b)=>b.score-a.score).map(entry=>entry.item)
  }
  private async custom(owner:string):Promise<Sticker[]> {
    try { return JSON.parse(await readFile(join(this.directory(owner),'index.json'),'utf8')) as Sticker[] }
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}
  }
  private async save(owner:string,items:Sticker[]) {
    const dir=this.directory(owner);await mkdir(dir,{recursive:true,mode:0o700})
    const temp=join(dir,`index-${randomUUID()}.tmp`)
    await writeFile(temp,JSON.stringify(items),{mode:0o600});await rename(temp,join(dir,'index.json'))
  }
  async image(owner:string,id:string):Promise<{item:Sticker;data:Buffer}> {
    if(!/^[\w-]{1,80}$/.test(id))throw new Error('表情标识无效')
    const builtin=BUILTIN_STICKERS.find(s=>s.id===id)
    if(builtin){const {data,...item}=builtin;return {item:{...item,builtin:true},data:Buffer.from(data,'base64')}}
    const item=(await this.custom(owner)).find(s=>s.id===id)
    if(!item)throw new Error('表情不存在或已移除')
    const data=await readFile(join(this.directory(owner),id))
    if(createHash('sha256').update(data).digest('hex')!==id)throw new Error('表情文件校验失败')
    return {item,data}
  }
  async upload(owner:string,name:unknown,tags:unknown,base64:unknown):Promise<Sticker> {
    if(typeof name!=='string'||!name.trim()||name.length>60)throw new Error('请填写 1–60 字的表情名称')
    if(!Array.isArray(tags)||tags.length>8||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>30))throw new Error('最多 8 个标签，每个 1–30 字')
    if(typeof base64!=='string'||base64.length>Math.ceil(LIMIT/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw new Error('图片编码或大小无效')
    const data=Buffer.from(base64,'base64'),mediaType=stickerMediaType(data)
    const id=createHash('sha256').update(data).digest('hex')
    return this.serial(owner,async()=>{
      const items=await this.custom(owner),old=items.find(s=>s.id===id)
      if(!old&&(items.length>=50||items.reduce((n,s)=>n+s.size,0)+data.length>50*1024*1024))throw new Error('每位伙伴最多 50 张自定义表情，总计 50 MB')
      const item={id,name:name.trim(),tags:[...new Set((tags as string[]).map(t=>t.trim()))],mediaType,size:data.length}
      await mkdir(this.directory(owner),{recursive:true,mode:0o700})
      await writeFile(join(this.directory(owner),id),data,{mode:0o600})
      await this.save(owner,[...items.filter(s=>s.id!==id),item]);return item
    })
  }
  async remove(owner:string,id:string):Promise<void> {
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('内置表情无需删除；关闭表情开关即可停用')
    await this.serial(owner,async()=>{await this.save(owner,(await this.custom(owner)).filter(s=>s.id!==id));await rm(join(this.directory(owner),id),{force:true})})
  }
}
