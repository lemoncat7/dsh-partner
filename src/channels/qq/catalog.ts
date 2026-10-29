import { createHash } from 'node:crypto'
import { validEmojiPreview } from '../../chat/sticker-adapter.js'
export interface QqFace { nativeId?:string; kind?:'custom'; id:string; name:string; category:string; image?:string; tags?:string[] }
/** SnowLuma's catalog often contains animation ZIPs, not directly displayable images.
 * Classic faces use the catalog em_code on QQ's public image CDN instead. */
export function qqFaceCatalog(value:unknown):QqFace[] {
  const packs=(value as {packs?:unknown})?.packs
  if(!Array.isArray(packs))return []
  const seen=new Set<string>(),faces:QqFace[]=[]
  for(const pack of packs)for(const emoji of Array.isArray(pack?.emojis)?pack.emojis:[]) {
    const id=String(emoji?.q_sid??'')
    if(!/^\d{1,6}$/.test(id)||seen.has(id)||faces.length>=2000)continue
    seen.add(id)
    let image:string|undefined
    try {
      const url=new URL(emoji.url)
      if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/\.(png|gif|webp|jpg)$/i.test(url.pathname)&&['qpic.cn','gtimg.cn'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h)))image=url.toString()
    }catch{}
    if(!image&&/^\d{1,6}$/.test(String(emoji.em_code??'')))image=`https://qzonestyle.gtimg.cn/qzone/em/e${emoji.em_code}.gif`
    faces.push({id,tags:Array.isArray(emoji.emoji_name_alias)?emoji.emoji_name_alias.filter((t:unknown)=>typeof t==='string').slice(0,8):[],name:String(emoji.q_des||emoji.em_code||id).slice(0,80),category:String(pack.pack_name??'QQ 表情').slice(0,80),...(image?{image}:{})})
  }
  return faces
}

export function qqCustomCatalog(value:unknown):QqFace[] {
 if(!Array.isArray(value))return []
 return value.slice(0,200).filter(e=>typeof e?.emoji_id==='string'&&e.emoji_id.length>0&&e.emoji_id.length<=512&&!/[\x00-\x1f]/.test(e.emoji_id)).map((e,i)=>({kind:'custom',nativeId:e.emoji_id,id:createHash('sha256').update(e.emoji_id).digest('hex').slice(0,32),name:String(e.desc||`收藏表情 ${i+1}`).slice(0,80),category:'QQ 收藏表情',tags:e.desc?[String(e.desc).slice(0,80)]:[],...(typeof e.url==='string'&&validEmojiPreview(e.url)?{image:e.url}:{})}))
}
