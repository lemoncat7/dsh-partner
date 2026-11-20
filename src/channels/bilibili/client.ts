import {createHash} from 'node:crypto'
import {readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import type {PartnerCredentialVault} from '../../credentials.js'

const api='https://api.bilibili.com'
const passport='https://passport.bilibili.com'
const creator='https://member.bilibili.com'
const videoHeaders={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/'}
const headers={...videoHeaders,Origin:'https://www.bilibili.com'}
const wbiOrder=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13]
type Param=string|number|boolean|undefined
type Params=Record<string,Param>
export interface BiliCredential {uid:string;session:string;csrf:string;device?:string}
export class BiliApiError extends Error {
  constructor(readonly code:number){super('B 站接口返回 '+code)}
}
export const loginRequired=()=>Object.assign(Error('B 站登录已失效，请重新扫码'),{notSubmitted:true,loginRequired:true})
function query(values:Params){
  return new URLSearchParams(Object.entries(values).filter((entry):entry is [string,Exclude<Param,undefined>]=>entry[1]!==undefined).map(([k,v])=>[k,String(v)]))
}

export function mediaUrl(value:string,domains=['bilivideo.com','bilivideo.cn','hdslb.com']){
  const url=new URL(value.startsWith('//')?'https:'+value:value)
  if(url.protocol!=='https:'||url.username||url.password||url.port||!domains.some(domain=>url.hostname.endsWith('.'+domain)))throw Error('B 站媒体地址不受支持')
  return url
}

export async function responseJson(response:Response,limit=2_000_000){
  if(!response.ok){
    await response.body?.cancel()
    throw new BiliApiError(response.status)
  }
  const reader=response.body?.getReader()
  if(!reader)throw Error('B 站接口未返回内容')
  const chunks:Uint8Array[]=[]
  let bytes=0
  try{
    for(;;){
      const {done,value}=await reader.read()
      if(done)break
      bytes+=value.length
      if(bytes>limit)throw Error('B 站响应超出大小限制')
      chunks.push(value)
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
  const parse=JSON.parse as (value:string,reviver:(key:string,value:unknown,context?:{source?:string})=>unknown)=>any
  return parse(Buffer.concat(chunks).toString('utf8'),(_,value,context)=>
    typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)&&/^-?\d+$/.test(context?.source??'')?context!.source:value)
}

export class BiliClient {
  private logins=new Map<string,{key:string;expires:number}>()
  private device:{id:string;expires:number}|undefined
  private wbi:{key:string;expires:number}|undefined
  constructor(private readonly vault:Pick<PartnerCredentialVault,'readBilibili'|'writeBilibili'|'deleteBilibili'>,private readonly importRoot?:string){}
  private importFile(channel:string){
    return this.importRoot&&/^bilibili-[a-z0-9-]{1,80}$/i.test(channel)?join(this.importRoot,channel+'.json'):undefined
  }
  async credential(channel:string){
    const existing=await this.vault.readBilibili(channel)
    const path=this.importFile(channel)
    if(!path)return existing
    let raw:string
    try{raw=await readFile(path,'utf8')}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return existing
      throw error
    }
    if(existing){await rm(path,{force:true});return existing}
    const {dedeuserid:uid,sessdata:session,bili_jct:csrf,buvid3:device}=JSON.parse(raw)
    if(typeof uid!=='string'||!/^\d+$/.test(uid)||typeof session!=='string'||!session||/[;\s]/.test(session)||
      typeof csrf!=='string'||! /^[a-f0-9]{32}$/i.test(csrf))throw Error('迁入的 B 站凭据无效，请重新扫码')
    const credential={uid,session,csrf,...(typeof device==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(device)?{device}:{})}
    await this.vault.writeBilibili(channel,credential)
    await rm(path,{force:true})
    return credential
  }
  private cookies(cred?:BiliCredential,device?:string){
    return [cred&&'SESSDATA='+cred.session,cred&&'bili_jct='+cred.csrf,cred&&'DedeUserID='+cred.uid,(cred?.device||device)&&'buvid3='+(cred?.device||device)].filter(Boolean).join('; ')
  }
  private async deviceId(signal:AbortSignal){
    if(this.device&&this.device.expires>Date.now())return this.device.id
    const {data}=await this.raw(api+'/x/frontend/finger/spi',signal)
    if(typeof data?.b_3==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(data.b_3)){
      this.device={id:data.b_3,expires:Date.now()+3600_000};return this.device.id
    }
  }
  private async key(signal:AbortSignal){
    if(this.wbi&&this.wbi.expires>Date.now())return this.wbi.key
    const {data}=await this.raw(api+'/x/web-interface/nav',signal)
    const source=[data?.wbi_img?.img_url,data?.wbi_img?.sub_url].map(value=>
      typeof value==='string'?(new URL(value).pathname.split('/').pop()??'').split('.')[0]:'').join('')
    if(source.length<64)throw Error('B 站暂未提供查询签名资料')
    const key=wbiOrder.map(index=>source[index]).join('')
    this.wbi={key,expires:Date.now()+600_000};return key
  }
  private async signed(values:Params,signal:AbortSignal){
    const key=await this.key(signal)
    const pairs=query({...values,wts:Math.floor(Date.now()/1000)})
    pairs.sort()
    const parts=[...pairs].map(([name,value])=>encodeURIComponent(name)+'='+encodeURIComponent(value.replace(/[!'()*]/g,''))).join('&')
    return parts+'&w_rid='+createHash('md5').update(parts+key).digest('hex')
  }

  private async raw(address:string,signal:AbortSignal,cred?:BiliCredential,body?:BodyInit,options:{json?:boolean;device?:string}={}){
    const cookie=this.cookies(cred,options.device)
    const response=await fetch(address,{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{...headers,...(options.json?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
      ...(body!==undefined?{body}:{}),signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])})
    const value=await responseJson(response)
    return {data:value.data??value.result,code:value.code,response}
  }

  async preupload(params:URLSearchParams,cred:BiliCredential,signal:AbortSignal){
    const response=await fetch(creator+'/preupload?'+params,{
      headers:{...headers,Cookie:this.cookies(cred)},redirect:'error',
      signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),
    })
    const result=await responseJson(response)
    if(typeof result.code==='number'&&result.code!==0)throw new BiliApiError(result.code)
    return result
  }

  async request(path:string,signal:AbortSignal,options:{
    host?:'creator'|'message';cred?:BiliCredential;params?:Params;form?:Params|FormData;json?:unknown;wbi?:boolean;device?:boolean
  }={}){
    const {cred,params={},form,json,wbi}=options
    const host=options.host==='creator'?creator:options.host==='message'?'https://api.vc.bilibili.com':api
    const address=host+path+'?'+(wbi?await this.signed(params,signal):query(params))
    const body=json!==undefined?JSON.stringify(json):form instanceof FormData?form:form?query(form):undefined
    const device=options.device&&!cred?.device?await this.deviceId(signal):undefined
    const result=await this.raw(address,signal,cred,body,{json:json!==undefined,...(device?{device}:{})})
    if(result.code===-101&&cred)throw loginRequired()
    if(result.code!==0)throw new BiliApiError(typeof result.code==='number'?result.code:502)
    return result.data
  }

  async account(channel:string,operation:string,signal:AbortSignal){
    if(operation==='login'){
      const {data,code}=await this.raw(passport+'/x/passport-login/web/qrcode/generate?source=main-fe-header',signal)
      if(code!==0||typeof data?.qrcode_key!=='string'||typeof data?.url!=='string')throw Error('未能生成 B 站登录二维码')
      const url=new URL(data.url)
      if(url.protocol!=='https:'||!['passport.bilibili.com','account.bilibili.com'].includes(url.hostname)||url.port||url.username||url.password)throw Error('B 站扫码地址无效')
      this.logins.set(channel,{key:data.qrcode_key,expires:Date.now()+180_000})
      return {status:'qrcode',url:url.href,expiresIn:180}
    }
    if(operation==='logout'){
      this.logins.delete(channel)
      const path=this.importFile(channel)
      if(path)await rm(path,{force:true})
      await this.vault.deleteBilibili(channel);return {status:'logged_out',logged_in:false}
    }
    if(operation==='login_check'){
      const pending=this.logins.get(channel)
      if(!pending||pending.expires<=Date.now()){
        this.logins.delete(channel)
        const identity=await this.status(channel,signal)
        return identity.logged_in?{...identity,status:'done'}:{status:'expired'}
      }
      const {data,code,response}=await this.raw(passport+'/x/passport-login/web/qrcode/poll?'+
        query({qrcode_key:pending.key,source:'main-fe-header'}),signal)
      if(code!==0)throw Error('B 站登录检查失败')
      if(data?.code===86101||data?.code===86090)return {status:data.code===86090?'scanned':'waiting'}
      if(data?.code===86038){this.logins.delete(channel);return {status:'expired'}}
      if(data?.code!==0)throw Error('B 站登录状态无效')
      const values=new Map<string,string>()
      if(typeof data.url==='string')for(const [key,value] of new URL(data.url).searchParams)values.set(key.toLowerCase(),value)
      for(const c of response.headers.getSetCookie()){
        const pair=c.split(';',1)[0]??'',at=pair.indexOf('=')
        if(at>0)values.set(pair.slice(0,at).toLowerCase(),pair.slice(at+1))
      }
      const session=values.get('sessdata'),csrf=values.get('bili_jct'),uid=values.get('dedeuserid')
      if(!session||!/^[^\s;\r\n]+$/.test(session)||!csrf||!/^[a-f0-9]{32}$/i.test(csrf)||!uid||!/^\d+$/.test(uid))throw Error('B 站扫码未返回完整凭据，请重新扫码')
      const device=values.get('buvid3')??await this.deviceId(signal).catch(()=>undefined)
      const cred={uid,session,csrf,...(device?{device}:{})}
      const identity=await this.identity(cred,signal)
      if(!identity.logged_in)throw Error('B 站扫码凭据核对失败，请重新扫码')
      await this.vault.writeBilibili(channel,cred)
      this.logins.delete(channel)
      return {...identity,status:'done'}
    }
    return this.status(channel,signal)
  }

  private async status(channel:string,signal:AbortSignal){
    const cred=await this.credential(channel)
    return cred?this.identity(cred,signal):{status:'logged_out',logged_in:false}
  }
  private async identity(cred:BiliCredential,signal:AbortSignal){
    const {code,data}=await this.raw(api+'/x/web-interface/nav',signal,cred)
    if(code===-101||code===0&&data?.isLogin===false)return {status:'logged_out',logged_in:false}
    if(code!==0||!data?.isLogin||String(data.mid)!==cred.uid)throw Error('B 站账号信息核对失败')
    return {status:'done',logged_in:true,uid:cred.uid,name:data.uname,avatar:data.face}
  }

  async action(operation:string,p:Record<string,unknown>,signal:AbortSignal,cred?:BiliCredential,guard?:()=>void):Promise<unknown>{
    const bvid=p.bvid as string,page=Number(p.page??1),uid=p.uid as string
    const get=(path:string,params:Params={},wbi=false)=>this.request(path,signal,{params,wbi,device:true,...(cred?{cred}:{})})
    const create=(path:string,form:Params,host?:'message')=>{
      if(!cred)throw loginRequired()
      guard?.()
      return this.request(path,signal,{cred,form:{...form,csrf:cred.csrf,csrf_token:cred.csrf},...(host?{host}:{})})
    }
    const view=()=>get('/x/web-interface/view',{bvid})
    const videoList=(rows:unknown)=>Array.isArray(rows)?rows.slice(0,20).map(row=>Object.fromEntries(
      ['bvid','aid','title','author','owner','description','desc','duration','stat'].map(k=>[k,row[k]]))):[]
    switch(operation){
      case 'share_link':return {url:'https://www.bilibili.com/video/'+bvid,published:false}
      case 'search':return {videos:videoList((await get('/x/web-interface/wbi/search/type',{keyword:String(p.keyword),search_type:'video',page},true))?.result)}
      case 'hot':return {videos:videoList((await get('/x/web-interface/popular',{pn:page,ps:20}))?.list)}
      case 'video':return view()
      case 'user_videos':return get('/x/space/wbi/arc/search',{mid:uid,pn:page,ps:20,order:'pubdate'},true)
      case 'user_dynamics':return get('/x/polymer/web-dynamic/v1/feed/space',{host_mid:uid,offset:String(p.offset??''),timezone_offset:-480})
      case 'favorite_lists':return get('/x/v3/fav/folder/created/list-all',{up_mid:cred?.uid,type:2})
      case 'favorite_content':return get('/x/v3/fav/resource/list',{media_id:String(p.media_id),pn:page,ps:20,platform:'web'})
      case 'replies':return get('/x/msgfeed/reply')
      case 'mentions':return get('/x/msgfeed/at')
      case 'unread':return get('/x/msgfeed/unread')
      case 'follow':return create('/x/relation/modify',{fid:uid,act:p.follow?1:2,re_src:11})
      case 'like':return create('/x/web-interface/archive/like',{bvid,like:p.status?1:2})
      case 'repost':return create('/dynamic_repost/v1/dynamic_repost/repost',{dynamic_id:String(p.dynamic_id),content:String(p.text),uid:cred?.uid},'message')
      case 'upload_categories':{
        const data=await this.request('/x/vupre/web/archive/pre',signal,{host:'creator',params:{lang:'cn'},...(cred?{cred}:{})})
        return {types:data?.typelist??data?.types??[]}
      }
      case 'comments':return get('/x/v2/reply',{oid:(await view()).aid,type:1,pn:page,ps:20})
      case 'favorite':return create('/x/v3/fav/resource/deal',{rid:(await view()).aid,type:2,add_media_ids:p.add?String(p.media_id):undefined,del_media_ids:p.add?undefined:String(p.media_id)})
      case 'comment':return create('/x/v2/reply/add',{oid:(await view()).aid,type:1,message:String(p.text),root:p.root as string,parent:p.parent as string,plat:1})
      case 'dynamic':
      case 'share_dynamic':guard?.();return this.dynamic(String(p.text)+(operation==='share_dynamic'?'\nhttps://www.bilibili.com/video/'+bvid:''),[],signal,cred)
      case 'subtitle':{
        const video=await view(),cid=video.pages?.[0]?.cid??video.cid
        const info=await get('/x/player/wbi/v2',{bvid,cid},true)
        const options=info?.subtitle?.subtitles??[]
        const item=options.find((entry:{lan:string})=>['ai-zh','zh-CN','zh'].includes(entry.lan))??options[0]
        if(!item?.subtitle_url)return {available:false,message:'没有可用字幕'}
        const address=mediaUrl(item.subtitle_url,['hdslb.com'])
        const data=await responseJson(await fetch(address,{headers:videoHeaders,redirect:'error',signal}),1_048_576)
        return {available:true,language:item.lan,text:data.body?.map((row:{content:string})=>row.content).join('\n').slice(0,12000)??''}
      }
      case 'video_stream':{
        const video=await view(),cid=video.pages?.[page-1]?.cid
        if(!cid)throw Error('没有该视频分集')
        const data=await get('/x/player/wbi/playurl',{bvid,cid,qn:64,fnval:16,fnver:0,fourk:0,platform:'html5'},true)
        const link=(value:any)=>{
          for(const candidate of [value.baseUrl??value.base_url??value.url,...(value.backupUrl??value.backup_url??[])]){
            if(typeof candidate==='string'){try{return mediaUrl(candidate).href}catch{continue}}
          }
          throw Error('未获得可用播放链接')
        }
        const base={bvid,page,temporary:true,downloaded:false,interpreted:false,headers:videoHeaders}
        if(data?.durl?.length)return {...base,mode:'progressive',segments:data.durl.map((part:any)=>({url:link(part),durationMs:part.length}))}
        if(!data?.dash?.video?.length)throw Error('没有可用的播放流')
        const tracks=data.dash.video as Array<{codecs?:string;bandwidth:number;width?:number;height?:number}>
        const track=[...tracks].sort((a,b)=>Number(!a.codecs?.startsWith('avc'))-Number(!b.codecs?.startsWith('avc'))||a.bandwidth-b.bandwidth)[0]!
        const audio=data.dash.audio?.[0]
        return {...base,mode:'dash',video:{url:link(track),codec:track.codecs,width:track.width,height:track.height},...(audio?{audio:{url:link(audio),codec:audio.codecs}}:{})}
      }
      default:throw Object.assign(Error('B 站接口未实现'),{notSubmitted:true})
    }
  }

  async dynamic(text:string,pics:unknown[],signal:AbortSignal,cred?:BiliCredential){
    if(!cred)throw loginRequired()
    const data=await this.request('/x/dynamic/feed/create/dyn',signal,{cred,params:{csrf:cred.csrf},json:{dyn_req:{
      content:{contents:text?[{raw_text:text,type:1,biz_id:''}]:[]},scene:pics.length?2:1,
      meta:{app_meta:{from:'create.dynamic.web',mobi_app:'web'}},... (pics.length?{pics}:{}),attach_card:null}}})
    const id=String(data?.dyn_id_str??data?.dynamic_id_str??data?.dynamic_id??'')
    if(!/^\d+$/.test(id))throw Error('动态提交结果待核实，请勿重复发布')
    return {dynamic_id:id,url:'https://t.bilibili.com/'+id}
  }
}
