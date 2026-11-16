import {createHash} from 'node:crypto'

export type ContinuousStatus='running'|'paused'|'stopped'|'completed'
export interface ContinuousTask {
 id:string;routeId:string;sessionId:string;title:string;instruction:string;until:string
 tabId:string;url:string;selector:string;browserRevision:number;revision:number
 status:ContinuousStatus;phase:'waiting'|'checking'|'ready'|'budget'|'blocked';reason:string
 createdAt:number;updatedAt:number;checkedAt?:number;changedAt?:number;reviewedAt?:number;wakeAt?:number
 nextCheckAt:number;nextReviewAt:number;failures:number;checks:number;changes:number;reviews:number;wakes:number
 seen:string[];pending:string[];scene:string;lastEvent:string;lastEvidence?:string;endEvidence?:string
 claim?:{messageId:string;revision:number;at:number};sourceEvidence:string
 pendingEvent?:{text:string;evidence:string;at:number}
 budgetUntil?:number
 nextSocialAt?:number
}
export interface ContinuousCharge {id:string;at:number;reserved:number;used?:number;kind:'review'|'chat'}
export interface ContinuousState {tasks:ContinuousTask[];budget:number;charges:ContinuousCharge[]}
export const DEFAULT_CONTINUOUS_BUDGET=60000
export const continuousState=():ContinuousState=>({tasks:[],budget:DEFAULT_CONTINUOUS_BUDGET,charges:[]})
export const terminal=(t:ContinuousTask)=>t.status==='stopped'||t.status==='completed'
export function continuousUsage(state:ContinuousState,now=Date.now()):number {
 return state.charges.filter(c=>now-c.at<3600000).reduce((n,c)=>n+(c.used??c.reserved),0)
}
export function normalizedBlock(text:string):string {
 return text.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim().slice(0,800)
}
export function meaningfulBlocks(blocks:unknown):string[]{
 if(!Array.isArray(blocks))throw Error('页面正文格式无效')
 return [...new Set(blocks.filter((b):b is string=>typeof b==='string').map(normalizedBlock).filter(b=>b.length>=6&&!/^[\d\s:：./年月日时分秒分钟前后-]+$/.test(b)&&!/^\d+(?:\.\d+)?[万亿kKmM]?\s*(?:观看|人气|点赞|评论|在线|views?|likes?)$/iu.test(b)))].slice(0,256)
}
export function updateObservation(task:ContinuousTask,blocks:unknown,now:number):void {
 const rows=meaningfulBlocks(blocks)
 if(!rows.length)throw Error('未读到直播正文，请核对页面加载、登录或正文选择器')
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),known=new Set(task.seen),fresh=rows.filter(s=>!known.has(hash(s)))
 task.checks++;task.checkedAt=now;task.failures=0
 if(!task.seen.length){task.seen=rows.map(hash);task.scene=rows.slice(-4).join('\n').slice(0,1000);task.reason='已建立当前正文基线，等待新内容';return}
 task.seen=[...new Set([...task.seen,...rows.map(hash)])].slice(-2048)
 if(fresh.length){task.changes+=fresh.length;task.changedAt=now;task.pending=[...new Set([...task.pending,...fresh])].slice(-16);task.reason='新内容已去重合并，等待判断';}
 else task.reason='正文没有新增，未调用模型'
}
export function validateContinuous(value:ContinuousState|undefined):void {
 if(!value)return
 if(!Array.isArray(value.tasks)||value.tasks.length>24||!Number.isSafeInteger(value.budget)||value.budget<10000||value.budget>200000||!Array.isArray(value.charges)||value.charges.length>512)throw Error('持续任务状态无效')
 const ids=new Set<string>()
 for(const t of value.tasks){
  if(!t.id||ids.has(t.id)||!['running','paused','stopped','completed'].includes(t.status)||!Number.isSafeInteger(t.revision)||!Number.isFinite(t.nextCheckAt)||!Array.isArray(t.seen)||t.seen.length>2048||!Array.isArray(t.pending)||t.pending.length>16)throw Error('持续任务记录无效')
  ids.add(t.id)
  for(const key of ['title','instruction','until','tabId','url','selector','routeId','sessionId','scene','reason','sourceEvidence'] as const)if(typeof t[key]!=='string'||t[key].length>4096)throw Error('持续任务字段无效')
 }
}
