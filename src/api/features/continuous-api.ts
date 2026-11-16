import type {IncomingMessage,ServerResponse} from 'node:http'
import type {ContinuousService} from '../../continuous/service.js'
import type {PartnerStore} from '../../store.js'
import type {BrowserService} from '../../browser/service.js'
import {mutation,readObject,sendJson} from '../http.js'
export async function dispatchContinuousApi(req:IncomingMessage,res:ServerResponse,s:string[],service:ContinuousService,store:PartnerStore,browser:BrowserService):Promise<boolean>{
 if(s[0]!=='continuous'||s.length<2||s.length>4)return false
 const owner=s[1]!
 if(s.length===2&&req.method==='GET'){sendJson(res,200,service.list(owner));return true}
 if(s.length===3&&s[2]==='sources'&&req.method==='GET'){
  const tabs=await browser.run(owner,{action:'tabs'},AbortSignal.timeout(10000),()=>{},true)
  sendJson(res,200,{tabs:tabs.tabs,routes:store.snapshot().sessions.filter(r=>r.companionId===owner).map(r=>({id:r.id,label:r.kind==='local'?'本地会话':(store.snapshot().channels.find(c=>c.id===r.channelId)?.name??'渠道')+' · '+r.userId}))});return true
 }
 if(req.method!=='POST')return false
 mutation(req);const body=await readObject(req,8000)
 if(s.length===2){const created=await service.create(owner,body,'用户在持续任务面板创建');sendJson(res,200,{task:service.list(owner).tasks.find(t=>t.id===created.id)});return true}
 if(s.length===3&&s[2]==='budget'){await service.budget(owner,body.budget as number);sendJson(res,200,service.list(owner));return true}
 if(s.length===4&&s[3]==='action'){
  if(!['pause','resume','stop'].includes(String(body.action)))throw Error('未知持续任务操作')
  await service.control(owner,s[2]!,body.action as 'pause'|'resume'|'stop','',body.expectedRevision as number);sendJson(res,200,service.list(owner));return true
 }
 return false
}
