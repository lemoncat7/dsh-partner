import type {IncomingMessage,ServerResponse} from 'node:http'
import type {TtsService} from '../../voice/service.js'
import {mutation,readObject,sendJson,httpError} from '../http.js'
export async function dispatchTtsApi(req:IncomingMessage,res:ServerResponse,s:string[],service:TtsService):Promise<boolean>{
 if(s[0]==='tts'&&s[1]==='profiles'&&s.length===3){
  const owner=s[2]!
  if(req.method==='GET'){sendJson(res,200,{profiles:service.list(owner)});return true}
  mutation(req);const body=await readObject(req,50000)
  if(req.method==='POST'){sendJson(res,200,await service.save(owner,body));return true}
  if(req.method==='DELETE'){if(typeof body.id!=='string')throw httpError(400,'服务 ID 无效');await service.remove(owner,body.id,body.expectedUpdatedAt);sendJson(res,200,{removed:true});return true}
 }
 if(s[0]==='tts'&&s[1]==='preview'&&s.length===3&&req.method==='POST'){
  mutation(req);const b=await readObject(req,5000);if(typeof b.profileId!=='string'||typeof b.text!=='string'||!b.text.trim()||b.text.length>200)throw httpError(400,'试听文本须为 1–200 字')
  const abort=new AbortController();const cancel=()=>{if(!res.writableEnded)abort.abort()};res.on('close',cancel)
  try{const audio=await service.preview(s[2]!,b.profileId,b.text,abort.signal);sendJson(res,200,{mediaType:audio.mediaType,audio:audio.data.toString('base64'),bytes:audio.data.length})}finally{res.off('close',cancel)}return true
 }
 if(s[0]==='channels'&&s.length===3&&s[2]==='tts'&&req.method==='POST'){mutation(req);await service.configure(s[1]!,await readObject(req));sendJson(res,200,{saved:true});return true}
 return false
}
