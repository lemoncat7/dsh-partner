import type {DirectBatch, DirectMessage, DirectPlatform, DirectTransport} from './transport.js'
import { matrixMessage } from './message.js'

/** Discover conversations without granting access. Every candidate still passes
 * the same two-member / no-encryption validation as explicitly pinned rooms. */
export async function pollDiscovered(platform:DirectPlatform, accountId:string, cursor:string|undefined, signal:AbortSignal,
  request:(path:string,body?:unknown)=>Promise<any>, room:(id:string)=>DirectTransport, waitMs=20000):Promise<DirectBatch> {
  const messages:DirectMessage[]=[]
  if(platform==='matrix') {
    let encrypted=false
    const filter=JSON.stringify({room:{timeline:{limit:100}},presence:{types:[]}})
    const data=await request('/_matrix/client/v3/sync?timeout='+waitMs+'&filter='+encodeURIComponent(filter)+(cursor?'&since='+encodeURIComponent(cursor):''))
    if(typeof data.next_batch!=='string')throw new Error('Matrix 同步游标缺失')
    const invites=Object.entries(data.rooms?.invite??{})
    if(invites.length>50)throw new Error('房间邀请过多，请清理后重连')
    for(const [id,value] of invites) {
      const events=(value as any)?.invite_state?.events
      if(!Array.isArray(events))continue
      if(events.some(e=>e.type==='m.room.encryption')){encrypted=true;continue}
      const members=events.filter(e=>e.type==='m.room.member'&&['join','invite'].includes(e.content?.membership))
      const self=members.find(e=>e.state_key===accountId&&e.content?.membership==='invite'&&e.content?.is_direct===true)
      if(!self||members.length!==2||!members.some(e=>e.state_key===self.sender&&e.content?.membership==='join'))continue
      await request('/_matrix/client/v3/join/'+encodeURIComponent(id),{})
    }
    const joined=Object.entries(data.rooms?.join??{})
    if(joined.length>100)throw new Error('私聊房间过多，请使用专用伙伴账号')
    for(const [id,value] of joined) {
      const timeline=(value as any)?.timeline
      const stateEvents=(value as any)?.state?.events??[]
      if(stateEvents.some((e:any)=>e.type==='m.room.encryption')||(timeline?.events??[]).some((e:any)=>e.type==='m.room.encryption'||e.type==='m.room.encrypted')){encrypted=true;continue}
      if(!cursor||!timeline?.events?.length)continue
      let identity
      try {identity=await room(id).validate(signal)}catch(error){
        if(error instanceof Error&&/加密房间/.test(error.message)){encrypted=true;continue}
        if(error instanceof Error&&/必须只有机器人/.test(error.message))continue
        throw error
      }
      if(timeline.limited)throw new Error('Matrix 私聊消息出现缺口，请检查后重连')
      for(const event of timeline.events) {
        const message = matrixMessage(event, identity.peerId, id)
        if (message) messages.push(message)
      }
    }
    return {cursor:data.next_batch,messages,...(encrypted?{warning:'检测到 Matrix 加密会话，已跳过：只有未加密的双人会话才能获取配对码和交流。请新建未开启加密的会话并邀请机器人；其他未加密会话不受影响。'}:{})}
  }
  const startedAt=Date.now()
  const channels=await request(`/api/v4/users/${encodeURIComponent(accountId)}/channels`)
  if(!Array.isArray(channels))throw new Error('Mattermost 会话列表无效')
  const dms=channels.filter(c=>c.type==='D'&&!c.delete_at)
  if(dms.length>100)throw new Error('私聊会话过多，请使用专用伙伴账号')
  // Establish a watermark without replaying history. Overlap subsequent polls;
  // durable receipts deduplicate boundary timestamps.
  if(!cursor)return {cursor:String(startedAt),messages:[]}
  if(!/^\d+$/.test(cursor))throw new Error('Mattermost 同步游标无效')
  for(const channel of dms) {
    if(typeof channel.id!=='string')throw new Error('Mattermost 会话 ID 无效')
    const batch=await room(channel.id).poll(String(Math.max(0,Number(cursor)-1000)),signal)
    messages.push(...batch.messages.map(message=>({...message,targetId:channel.id})))
  }
  return {cursor:String(Math.max(Number(cursor),startedAt)),messages}
}
