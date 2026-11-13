import type {IncomingMessage,ServerResponse} from 'node:http'
import type {BrowserService} from '../../browser/service.js'
import {mutation,readObject,sendJson} from '../http.js'

export async function dispatchBrowserApi(req:IncomingMessage,res:ServerResponse,s:string[],service:BrowserService):Promise<boolean> {
  if(s[0]!=='browser'||s.length<2||s.length>3)return false
  const owner=s[1]!
  if(s.length===2&&req.method==='GET'){sendJson(res,200,{config:service.config(owner)??null});return true}
  if(s.length===2&&req.method==='POST'){mutation(req);sendJson(res,200,{config:await service.save(owner,await readObject(req,6000))});return true}
  if(s.length===3&&s[2]==='test'&&req.method==='POST'){
    mutation(req);const body=await readObject(req,6000),abort=new AbortController()
    const cancel=()=>{if(!res.writableEnded)abort.abort()};res.on('close',cancel)
    try{sendJson(res,200,await service.test(owner,body.endpoint,abort.signal))}finally{res.off('close',cancel)}
    return true
  }
  return false
}
