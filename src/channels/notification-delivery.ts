import { ReplySupersededError } from './reply-turn.js'
import { replyDeliveryParts } from '../chat/protocol.js'
import type {PartnerReply} from '../channel-message.js'
import type {PartnerStore} from '../store.js'
import {notificationFailureReason} from './notification-timeout.js'

export class NotificationDeferredError extends Error {
  constructor(){super('QQ 尚未上线，消息未发送，等待恢复连接')}
}

type Target = {channelId:string;userId:string}
export interface NotificationDeliveryRecord {
  id:string
  companionId:string
  createdAt:number
  completedAt?:number
  supersededAt?:number
  reply:PartnerReply
  targets:(Target & {sentParts:number[];lastAttemptAt?:number;lastError?:string;retrySafe?:boolean})[]
}
export interface DeliveryTiming {storeMs:number;partMs:number;totalMs:number;commits:number}
type Send = (target:Target, reply:PartnerReply, part:(index:number, send:()=>Promise<unknown>)=>Promise<void>)=>Promise<void>

/** Freeze recipients and payload for each logical notification. Persist each acknowledged part.
 * A lost remote acknowledgement may still cause a duplicate; channels do not offer exactly-once delivery. */
export class NotificationDelivery {
  private running=new Map<string,Promise<void>>()
  constructor(private store:PartnerStore){}
  deliver(id:string, companionId:string, targets:()=>Target[], reply:PartnerReply, send:Send, observe?:(timing:DeliveryTiming)=>void):Promise<void> {
    const key=JSON.stringify([companionId,id])
    const existing=this.running.get(key)
    if(existing)return existing
    const started=Date.now(),timing:DeliveryTiming={storeMs:0,partMs:0,totalMs:0,commits:0}
    const work=this.execute(key,companionId,targets,reply,send,timing).finally(()=>{this.running.delete(key);timing.totalMs=Date.now()-started;try{observe?.(timing)}catch{/* Observability cannot change a delivery result. */}})
    this.running.set(key,work)
    return work
  }
  private async execute(id:string,companionId:string,resolveTargets:()=>Target[],reply:PartnerReply,send:Send,timing:DeliveryTiming):Promise<void>{
    const update:PartnerStore['update']=async change=>{const start=Date.now();timing.commits++;try{return await this.store.update(change)}finally{timing.storeMs+=Date.now()-start}}
    let record=this.store.snapshot(['notificationDeliveries']).notificationDeliveries?.find(r=>r.id===id)
    if(record?.completedAt)return
    let firstAttempt=false
    if(!record){
      const targets=resolveTargets().filter((t,i,all)=>all.findIndex(x=>x.channelId===t.channelId&&x.userId===t.userId)===i)
      if(!targets.length)throw new Error('通知没有接收人')
      const saved=await update(state=>{
        const records=state.notificationDeliveries??=[]
        if(records.some(r=>r.id===id))return
        // Only completed records may be evicted. Pending progress must survive restarts.
        while(records.length>=1000){const index=records.findIndex(r=>r.completedAt!==undefined);if(index<0)throw new Error('待投递通知已达上限，请检查渠道连接');records.splice(index,1)}
        firstAttempt=true
        const now=Date.now()
        records.push({id,companionId,createdAt:now,reply:structuredClone(reply),targets:targets.map(t=>({...t,sentParts:[],lastAttemptAt:now}))})
      })
      record=saved.notificationDeliveries!.find(r=>r.id===id)!
    }
    if (reply.attachmentPolicy === 'text-only') {
      await this.store.update(state => {
        const saved = state.notificationDeliveries!.find(r => r.id === id)!
        saved.reply.attachments = []; saved.reply.attachmentPolicy = 'text-only'
        if (!saved.reply.chatParts) for (const target of saved.targets) target.sentParts = target.sentParts.filter(part => part === 0)
      })
      record = this.store.snapshot(['notificationDeliveries']).notificationDeliveries!.find(r => r.id === id)!
    }
    const frozen=record
    const deliveryParts=replyDeliveryParts(frozen.reply)
    const parts=deliveryParts.length
    const failures:unknown[]=[]
    const successful:Target[]=[]
    await Promise.all(frozen.targets.map(async target=>{
      if(target.sentParts.length===parts)return
      let currentPart:number|undefined
      try{
        if(!firstAttempt)await update(state=>{
          const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
          saved.lastAttemptAt=Date.now()
          delete saved.retrySafe
        })
        await send(target,frozen.reply,async(index,perform)=>{
          if(target.sentParts.includes(index))return
          currentPart=index
          const part=deliveryParts[index]
          const hash = part?.type === 'image' ? part.attachment.contentHash : undefined
          const scope = frozen.reply.attachmentScope
          const recipient = JSON.stringify([target.channelId, target.userId])
          const alreadySent = scope && hash && this.store.snapshot(['requirements']).requirements?.find(r => r.id === scope)?.attachmentReceipts?.[recipient]?.includes(hash)
          if (!alreadySent) {const start=Date.now();try{await perform()}finally{timing.partMs+=Date.now()-start}}
          await update(state=>{
            const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
            if(!saved.sentParts.includes(index))saved.sentParts.push(index)
            if (scope && hash) {
              const requirement = state.requirements?.find(r => r.id === scope)
              if (requirement) {
                const receipts = requirement.attachmentReceipts ??= {}
                const hashes = receipts[recipient] ??= []
                if (!hashes.includes(hash)) hashes.push(hash)
              }
            }
          })
          target.sentParts.push(index)
        })
        successful.push(target)
      }catch(error){
        if(error instanceof ReplySupersededError){
          await update(state=>{
            const saved=state.notificationDeliveries!.find(r=>r.id===id)!
            saved.supersededAt=Date.now();saved.completedAt=Date.now();saved.reply={text:'',attachments:[]}
            const recipient=saved.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
            delete recipient.lastError;delete recipient.retrySafe
          })
          return
        }
        const stage=currentPart===undefined?'接收人检查':frozen.reply.chatParts?`消息 ${currentPart+1}`:currentPart===0?'文字':`附件 ${currentPart}`
        const message=`${stage}：${notificationFailureReason(error)}`
        failures.push(new Error(message))
        await update(state=>{
          const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
          saved.lastError=message
          saved.retrySafe=currentPart===undefined&&error instanceof NotificationDeferredError
        })
      }
    }))
    // Each acknowledgement is already durable. Finish successful recipients and
    // the logical delivery together, instead of cloning/validating state again per target.
    if(successful.length||!failures.length)await update(state=>{
      const saved=state.notificationDeliveries!.find(r=>r.id===id)!
      for(const target of successful){const recipient=saved.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!;delete recipient.lastError;delete recipient.retrySafe}
      if(!failures.length){saved.completedAt=Date.now();saved.reply={text:'',attachments:[]}}
    })
    if(failures.length)throw new AggregateError(failures,`${failures.length} 个通知目标投递失败，等待重试；已成功部分已保存。${failures.slice(0,3).map(e=>(e as Error).message).join('；')}`)
  }
}
