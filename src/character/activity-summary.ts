import type {ActivityJournalEntry} from './activity-journal.js'
export const activityCategories=[
 {name:'网页与 B 站',matches:(n:string)=>/^(web_|partner_bilibili|partner_browser)/.test(n)},
 {name:'作品创作',matches:(n:string)=>/^(write|edit|generate_image|bash)(:|$)/.test(n)},
 {name:'表情收藏',matches:(n:string)=>n.startsWith('partner_stickers')},
 {name:'聊天与分享',matches:(n:string)=>/^(partner_chat_|partner_voice_reply|partner_send_attachment)/.test(n)},
 {name:'QQ 互动',matches:(n:string)=>n.startsWith('partner_qq')},
 {name:'QQ 空间浏览',matches:(n:string)=>/^partner_qq:(get_qzone_feeds|get_qzone_msg_list|get_qzone_msg_detail)$/.test(n)},
 {name:'空间与 B 站互动发布',matches:(n:string)=>/^(partner_qq:(send_qzone_msg|like_qzone|comment_qzone)|partner_bilibili:(like|favorite|follow|comment|dynamic|image_dynamic|share_dynamic|repost))$/.test(n)},
]
export function summarizeActivities(rows:ActivityJournalEntry[]){
 return {total:rows.length,confirmed:rows.filter(r=>r.sharing==='confirmed').length,pending:rows.filter(r=>r.sharing==='pending').length,unknown:rows.filter(r=>r.sharing===undefined).length,failed:rows.filter(r=>r.tools.some(t=>!t.ok)).length,categories:activityCategories.map(c=>({name:c.name,count:rows.filter(r=>r.tools.some(t=>c.matches(t.name))).length})).filter(c=>c.count)}
}
export function activitySharingLabel(row:ActivityJournalEntry):string{
 return row.sharing==='confirmed'?'已确认发送':row.sharing==='pending'?'发送待确认':row.sharing==='none'?'未发现发送记录':'历史发送状态未核实'
}

/** A durable acknowledged part proves sending; queued text alone never does. */
export function withActivityDeliveries<T extends {id:string;activityJournal?:ActivityJournalEntry[]}>(companion:T,deliveries:import('../channels/notification-delivery.js').NotificationDeliveryRecord[]):T{
 return {...companion,...(companion.activityJournal?{activityJournal:companion.activityJournal.map(row=>{
  const matching=deliveries.filter(d=>d.companionId===companion.id&&(d.reply.idleContactOrigin?.messageId===row.id||d.id===JSON.stringify([companion.id,`idle:${row.id}`])))
  if(!matching.length)return row
  return {...row,sharing:row.sharing==='confirmed'||matching.some(d=>d.targets.some(t=>t.sentParts.length>0))?'confirmed' as const:'pending' as const}
 })}:{})}
}
