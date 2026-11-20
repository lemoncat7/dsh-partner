import {join} from 'node:path'
import type {PartnerCredentialVault} from '../../credentials.js'
import {BiliApiError, BiliClient, loginRequired} from './client.js'
import {BiliUploads} from './uploads.js'
import {BILI_ACTION_MAP} from './catalog.js'
import type {BiliBackend} from './service.js'

const mediaOperations=new Set(['upload_health','upload_status','upload_draft','publish_video','image_dynamic'])
function bounded(value:unknown,depth=0):unknown{
  if(depth>8)return null
  if(typeof value==='string')return value.slice(0,12000)
  if(Array.isArray(value))return value.slice(0,30).map(item=>bounded(item,depth+1))
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,60)
    .filter(([key])=>!/cookie|token|sessdata|bili_jct|buvid|password|secret/i.test(key))
    .map(([key,item])=>[key,bounded(item,depth+1)]))
  return value??null
}

export class NativeBilibili {
  private readonly client:BiliClient
  private readonly uploads:BiliUploads
  constructor(credentials:PartnerCredentialVault,directory:string){
    this.client=new BiliClient(credentials,join(directory,'bilibili-import'))
    this.uploads=new BiliUploads(join(directory,'bilibili-media'),this.client)
  }
  close(){return this.uploads.close()}

  call:BiliBackend=async(channel,operation,params,signal,_requestId,scope)=>{
    const action=BILI_ACTION_MAP.get(operation)
    const guard=scope?.guard
    try{
      if(!action){
        if(!['status','login','login_check','logout'].includes(operation))throw Error('B 站操作不存在')
        if(operation==='logout')await this.uploads.cancel(channel)
        return await this.client.account(channel,operation,signal)
      }
      const credential=action.login?await this.client.credential(channel):undefined
      if(action.login&&(!credential||credential.uid!==scope?.accountId))throw loginRequired()
      guard?.()
      const callSignal=AbortSignal.any([signal,AbortSignal.timeout(mediaOperations.has(operation)?300_000:45_000)])
      const result=mediaOperations.has(operation)?
        await this.uploads.call(channel,operation,params,callSignal,credential,scope?.cwd,guard,scope?.checkChannel):
        await this.client.action(operation,params,callSignal,credential,guard)
      const safe=bounded(result)
      if(JSON.stringify(safe).length>500000)throw Error('B 站结果过大，请缩小查询范围')
      return {result:safe}
    }catch(error){
      if(signal.aborted)throw signal.reason
      if(error instanceof BiliApiError)throw error
      if(error instanceof Error&&['Error','AbortError','TimeoutError'].includes(error.name)&&!(error instanceof TypeError))throw error
      throw Error('B 站接口暂不可用，请检查连接')
    }
  }
}
