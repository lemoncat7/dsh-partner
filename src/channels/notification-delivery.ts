import type {PartnerReply} from '../channel-message.js'
import type {PartnerStore} from '../store.js'

type Target = {channelId:string;userId:string}
export interface NotificationDeliveryRecord {
  id:string
  companionId:string
  createdAt:number
  completedAt?:number
  reply:PartnerReply
  targets:(Target & {sentParts:number[]})[]
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
      try{
        await send(target,frozen.reply,async(index,perform)=>{
          if(target.sentParts.includes(index))return
          await perform()
          await this.store.update(state=>{
            const saved=state.notificationDeliveries!.find(r=>r.id===id)!.targets.find(t=>t.channelId===target.channelId&&t.userId===target.userId)!
            if(!saved.sentParts.includes(index))saved.sentParts.push(index)
          })
          target.sentParts.push(index)
        })
      }catch(error){failures.push(error)}
    }))
    if(failures.length)throw new AggregateError(failures,`${failures.length} 个通知目标投递失败，等待重试；已成功部分已保存`)
    await this.store.update(state=>{const saved=state.notificationDeliveries!.find(r=>r.id===id)!;saved.completedAt=Date.now();saved.reply={text:'',attachments:[]}})
  }
}
