import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PartnerStore } from '../../store.js'
import type { StickerLibrary } from '../../chat/stickers.js'
import { httpError, mutation, readObject, sendJson } from '../http.js'

export async function dispatchStickersApi(req:IncomingMessage,res:ServerResponse,segments:string[],library:StickerLibrary,store:PartnerStore):Promise<boolean> {
  if(segments[0]!=='companions'||segments[2]!=='stickers')return false
  const owner=segments[1]!
  if(!store.snapshot().companions.some(c=>c.id===owner)||store.isCompanionRemoving(owner))throw httpError(404,'伙伴不存在')
  if(req.method==='GET'&&segments.length===3){sendJson(res,200,{items:await library.list(owner)});return true}
  if(req.method==='GET'&&segments.length===4){
    const {item,data}=await library.image(owner,segments[3]!)
    res.setHeader('content-type',item.mediaType);res.setHeader('x-content-type-options','nosniff');res.setHeader('cache-control','private, no-store');res.setHeader('content-length',data.length);res.end(data);return true
  }
  if(req.method==='POST'&&segments.length===3){
    mutation(req);const body=await readObject(req,3*1024*1024)
    sendJson(res,201,await library.upload(owner,body.name,body.tags,body.base64));return true
  }
  if(req.method==='DELETE'&&segments.length===4){mutation(req);await library.remove(owner,segments[3]!);sendJson(res,200,{ok:true});return true}
  throw httpError(405,'不支持的表情库操作')
}
