import type {PartnerReply} from '../channel-message.js'
import type {PartnerStore} from '../store.js'
import {notificationFailureReason} from './notification-timeout.js'

type Target = {channelId:string;userId:string}
export interface NotificationDeliveryRecord {
  id:string
  companionId:string
  createdAt:number
  completedAt?:number
  reply:PartnerReply
  targets:(Target & {sentParts:number[];lastAttemptAt?:number;lastError?:string})[]
}
type Send = (target:Target, reply:PartnerReply, part:(index:number, send:()=>Promise<unknown>)=>Promise<void>)=>Promise<void>

/** Freeze recipients and payload for each logical notification. Persist each acknowledged part.
 * A lost remote acknowledgement may still cause a duplicate; channels do not offer exactly-once delivery. */
export class NotificationDelivery {
  private running=new Map<string,Promise<void>>()
  constructor(private store:PartnerStore){}
  deliver(id:string, companionId:string, targets:()=>Target[], reply:PartnerReply, send:Send):Promise<void> {
    const key=JSON.stringify([companionId,id])
    const existing=this.running.get(key)
    if(existing)return existing
    const work=this.execute(key,companionId,targets,reply,send).finally(()=>this.running.delete(key))
    this.running.set(key,work)
    return work
  }
  private async execute(id:string,companionId:string,resolveTargets:()=>Target[],reply:PartnerReply,send:Send):Promise<void>{
    let record=this.store.snapshot().notificationDeliveries?.find(r=>r.id===id)
    if(record?.completedAt)return
    if(!record){
      const targets=resolveTargets().filter((t,i,all)=>all.findIndex(x=>x.channelId===t.channelId&&x.userId===t.userId)===i)
      if(!targets.length)throw new Error('通知没有接收人')
      const saved=await this.store.update(state=>{
        const records=state.notificationDeliveries??=[]
        if(records.some(r=>r.id===id))return
        // Only completed records may be evicted. Pending progress must survive restarts.
        while(records.length>=1000){const index=records.findIndex(r=>r.completedAt!==undefined);if(index<0)throw new Error('待投递通知已达上限，请检查渠道连接');records.splice(index,1)}
        records.push({id,companionId,createdAt:Date.now(),reply:structuredClone(reply),targets:targets.map(t=>({...t,sentParts:[]}))})
      })
      record=saved.notificationDeliveries!.find(r=>r.id===id)!
    }
    const frozen=record
    const parts=frozen.reply.attachments.length+1
    const failures:unknown[]=[]
    await Promise.all(frozen.targets.map(async target=>{
      if(target.sentParts.length===parts)return
      let currentPart:number|undefined
      try{
        await this.store.update(state=>{
          const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
          saved.lastAttemptAt=Date.now()
        })
        await send(target,frozen.reply,async(index,perform)=>{
          if(target.sentParts.includes(index))return
          currentPart=index
          await perform()
          await this.store.update(state=>{
            const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
            if(!saved.sentParts.includes(index))saved.sentParts.push(index)
          })
          target.sentParts.push(index)
        })
        await this.store.update(state=>{
          const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
          delete saved.lastError
        })
      }catch(error){
        const stage=currentPart===undefined?'接收人检查':currentPart===0?'文字':`附件 ${currentPart}`
        const message=`${stage}：${notificationFailureReason(error)}`
        failures.push(new Error(message))
        await this.store.update(state=>{
          const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
          saved.lastError=message
        })
      }
    }))
    if(failures.length)throw new AggregateError(failures,`${failures.length} 个通知目标投递失败，等待重试；已成功部分已保存。${failures.slice(0,3).map(e=>(e as Error).message).join('；')}`)
    await this.store.update(state=>{const saved=state.notificationDeliveries!.find(r=>r.id===id)!;saved.completedAt=Date.now();saved.reply={text:'',attachments:[]}})
  }
}
