import {stageBiliMedia} from './media.js'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import type {PartnerStore} from '../../store.js'
import {BILI_ACTION_MAP,biliSettings,parseBiliSettings} from './catalog.js'
import {validateQqParams} from '../qq/actions.js'
export interface BiliReceipt {id:string;action:string;at:number;status:'pending'|'confirmed'|'unknown'|'failed';jobId?:string}
export type BiliBridge=(channelId:string,operation:string,params:Record<string,unknown>,signal:AbortSignal,requestId?:string)=>Promise<any>
export function createBiliBridge():BiliBridge{return async(channelId,operation,params,signal,requestId)=>{
 const token=(await readFile(process.env.PARTNER_BILIBILI_TOKEN_FILE??'/data/partner/bilibili-bridge-token','utf8')).trim()
 const response=await fetch((process.env.PARTNER_BILIBILI_URL??'http://dsh-bilibili:8091')+'/call',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({channelId,operation,params,requestId}),signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])})
 const raw=await response.text();if(raw.length>500000)throw Error('B 站结果过大，请缩小查询范围')
 const result=JSON.parse(raw);if(!response.ok||result.error){const e=Object.assign(new Error(String(result.error??'B 站服务不可用').slice(0,300)),{notSubmitted:result.notSubmitted===true,loginRequired:result.code==='LOGIN_REQUIRED'});throw e}
 return result
}}
export class BilibiliService {
 private busy=new Set<string>()
 constructor(private store:PartnerStore,private bridge:BiliBridge=createBiliBridge()){}
 private channel(id:string){const c=this.store.snapshot().channels.find(c=>c.id===id&&c.platform==='bilibili');if(!c||this.store.isCompanionRemoving(c.companionId))throw Error('B 站渠道不存在');return c}
 async create(companionId:string,name:string){const now=Date.now(),id='bilibili-'+randomUUID();await this.store.update(s=>{if(!s.companions.some(c=>c.id===companionId)||this.store.isCompanionRemoving(companionId))throw Error('伙伴不存在');if(s.channels.some(c=>c.companionId===companionId&&c.platform==='bilibili'))throw Error('此伙伴已有 B 站渠道');s.channels.push({id,companionId,platform:'bilibili',name:name.trim()||'B 站',accountId:'',enabled:true,createdAt:now,updatedAt:now,bilibili:biliSettings()})});return {id}}
 async settings(id:string,value:unknown,revision:number){const next=parseBiliSettings(value);await this.store.update(s=>{const c=s.channels.find(c=>c.id===id&&c.platform==='bilibili');if(!c||c.updatedAt!==revision)throw Error('配置已变化，请刷新后重试');c.bilibili=next;c.updatedAt=Math.max(Date.now(),c.updatedAt+1)})}
 async account(id:string,operation:'status'|'login'|'login_check'|'logout',signal=AbortSignal.timeout(45000)){
 const c=this.channel(id);if(this.busy.has(id))throw Error('B 站操作执行中，请稍后重试')
 this.busy.add(id)
 try {const r=await this.bridge(id,operation,{},signal)
 // Bind actual identity from the bridge only, never trust a browser/model UID.
 if(operation==='logout'||r.logged_in===true||r.logged_in===false)await this.store.update(s=>{const current=s.channels.find(x=>x.id===id&&x.platform==='bilibili');if(!current||current.updatedAt!==c.updatedAt)return;const next=r.logged_in?String(r.uid):'';if(current.accountId!==next){current.accountId=next;current.updatedAt=Math.max(Date.now(),current.updatedAt+1)}})
 return operation==='login'?{status:r.status,image:r.image,expiresIn:r.expiresIn}:{status:r.status,logged_in:r.logged_in,uid:r.uid,...(typeof r.name==='string'?{name:r.name.slice(0,100)}:{}),...(typeof r.avatar==='string'&&/^https:\/\/[^/]+\.hdslb\.com\//.test(r.avatar)?{avatar:r.avatar}:{})}
 } finally {this.busy.delete(id)}
 }
 async call(id:string,operation:string,params:Record<string,unknown>,signal:AbortSignal,guard:()=>void,cwd?:string,receiptParams:Record<string,unknown>=params){
 const action=BILI_ACTION_MAP.get(operation);if(!action)throw Error('B 站 API 不存在')
 validateQqParams(action.schema,params)
 if(operation==='image_dynamic'&&(!Array.isArray(params.image_paths)||!params.image_paths.length))throw Error('漫画图片须为1–9张')
 if(operation==='upload_draft'&&(!Array.isArray(params.tags)||!params.tags.length||(params.copyright===2&&!params.source)))throw Error('投稿需要至少一个标签；转载需要来源')
 for(const key of ['job_id','draft_id'])if(params[key]!==undefined&&!/^[a-f0-9]{32}$/.test(String(params[key])))throw Error('媒体任务 ID 无效')
 for(const key of ['uid','media_id','root','parent','dynamic_id'])if(params[key]!==undefined&&!/^[1-9]\d{0,24}$/.test(String(params[key])))throw Error(key+' 格式无效')
 if(params.bvid!==undefined&&!/^BV[0-9A-Za-z]{10}$/.test(String(params.bvid)))throw Error('BV 号格式无效')
 if(params.parent&&!params.root)throw Error('回复评论须提供 root 根评论 ID')
 const before=this.channel(id),revision=before.updatedAt
 const check=()=>{signal.throwIfAborted();guard();const c=this.channel(id),p=biliSettings(c.bilibili);if(!c.enabled||c.updatedAt!==revision||!p.enabledActions.includes(operation)||(action.login&&(!c.accountId||!p.privateActions)))throw Error('B 站能力已关闭或配置已变化')}
 check();if(this.busy.has(id))throw Error('此 B 站账号正在执行操作，请稍后再试');this.busy.add(id)
 const receipt=createHash('sha256').update(JSON.stringify([operation,receiptParams])).digest('hex')
 try{
  check()
  if(action.write){await this.store.update(s=>{check();const c=s.channels.find(c=>c.id===id)!;const prior=c.bilibiliActivity??[];if(prior.some(r=>r.id===receipt&&Date.now()-r.at<24*3600000&&r.status!=='failed'))throw Error('相同操作已提交或结果尚待核实，请勿重复发送');c.bilibiliActivity=[...prior,{id:receipt,action:operation,at:Date.now(),status:'pending' as const}].slice(-200)})}
  check()
  let request=params
  if(operation==='upload_draft'){const h=await this.bridge(id,'upload_health',{},signal);check();if(Number(h?.result?.cooldown?.retryAt)>Date.now()/1000)throw Object.assign(Error('B站上传限流冷却中，请稍后查看 upload_health；未重新传输素材'),{notSubmitted:true})}
  if(operation==='upload_draft'||operation==='image_dynamic'){if(!cwd)throw Object.assign(Error('当前会话没有可用工作目录'),{notSubmitted:true});try{request=await stageBiliMedia(id,cwd,params,signal,operation==='image_dynamic')}catch(e){throw Object.assign(e as Error,{notSubmitted:true})}check()}
  const result=await this.bridge(id,operation,request,signal,action.write?receipt:undefined)
  if(action.write)await this.finish(id,receipt,'confirmed',typeof result?.result?.id==='string'?result.result.id:undefined)
  if(operation==='upload_status'&&['failed','interrupted'].includes(result?.result?.status)&&result?.result?.published!==true)await this.store.update(s=>{const c=s.channels.find(c=>c.id===id);for(const r of c?.bilibiliActivity??[])if(r.jobId===params.job_id&&['upload_draft','image_dynamic'].includes(r.action))r.status='failed'})
  return result
 }catch(e){const failure=e as {notSubmitted?:boolean;loginRequired?:boolean};if(action.write)await this.finish(id,receipt,failure.notSubmitted?'failed':'unknown');if(failure.loginRequired)await this.store.update(s=>{const c=s.channels.find(c=>c.id===id);if(c&&c.updatedAt===revision){c.accountId='';c.updatedAt=Math.max(Date.now(),c.updatedAt+1)}});throw e}finally{this.busy.delete(id)}
 }
 private async finish(id:string,receipt:string,status:BiliReceipt['status'],jobId?:string){await this.store.update(s=>{const c=s.channels.find(c=>c.id===id);const r=c?.bilibiliActivity?.find(r=>r.id===receipt&&r.status==='pending');if(r){r.status=status;if(jobId)r.jobId=jobId}})}
}
