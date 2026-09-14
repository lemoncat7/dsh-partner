import { randomUUID } from 'node:crypto'
import type { PartnerOutboundAttachment } from '../../channel-message.js'
import { pollDiscovered } from './discovery.js'

export type DirectPlatform = 'matrix' | 'mattermost'
export interface DirectConfig { platform: DirectPlatform; baseUrl: string; targetId: string }
export interface DirectMessage { id: string; sender: string; text: string; targetId?: string }
export interface DirectBatch { cursor: string; messages: DirectMessage[] }
export interface ChannelSender {
  sendText(userId: string, text: string, context: string | undefined, signal?: AbortSignal): Promise<void>
  sendAttachment(userId: string, file: PartnerOutboundAttachment, context: string | undefined, signal?: AbortSignal): Promise<void>
}
export class ChannelHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`渠道请求失败（HTTP ${status}）`) }
}
export function directConfig(value: Record<string, unknown>): DirectConfig {
  if (value.platform !== 'matrix' && value.platform !== 'mattermost') throw new Error('请选择 Matrix 或 Mattermost')
  if (typeof value.baseUrl !== 'string' || (value.targetId !== undefined && (typeof value.targetId !== 'string' || value.targetId.length > 512))) throw new Error('服务器地址或会话 ID 无效')
  const url = new URL(value.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务器地址只能包含 HTTP(S) 地址和路径，不得带凭据或查询参数')
  return { platform: value.platform, baseUrl: url.toString().replace(/\/$/, ''), targetId: (value.targetId as string|undefined)?.trim() ?? '' }
}

/** Explicit, two-member conversations only. No group inference from display names. */
export class DirectTransport implements ChannelSender {
  private botId = ''
  private peerId = ''
  constructor(readonly config: DirectConfig, private readonly token: string, private readonly expected?: {accountId: string; peerId: string}) {}

  private async request(path: string, signal?: AbortSignal, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
    const response = await fetch(this.config.baseUrl + path, {
      method, redirect: 'error', headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : {'Content-Type': 'application/json'}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    })
    if (!response.ok) {
      const header=response.headers.get('retry-after')
      const retry=header ? (/^\d+$/.test(header) ? Number(header)*1000 : Date.parse(header)-Date.now()) : 0
      throw new ChannelHttpError(response.status,Number.isFinite(retry)?Math.max(0,Math.min(900_000,retry)):0)
    }
    if (!response.body) throw new Error('渠道返回空响应')
    let size = 0
    const chunks: Uint8Array[] = []
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength
      if (size > 4 * 1024 * 1024) throw new Error('渠道响应超过大小限制')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  async validate(signal?: AbortSignal): Promise<{accountId: string; peerId: string}> {
    if(!this.config.targetId) {
      const who=await this.request(this.config.platform==='matrix'?'/_matrix/client/v3/account/whoami':'/api/v4/users/me',signal)
      const id=this.config.platform==='matrix'?who.user_id:who.id
      if(typeof id!=='string'||!id||this.expected&&this.expected.accountId!==id)throw new Error('渠道账号身份无效或已变化')
      this.botId=id
      return {accountId:id,peerId:''}
    }
    const target = encodeURIComponent(this.config.targetId)
    if (this.config.platform === 'matrix') {
      const who = await this.request('/_matrix/client/v3/account/whoami', signal)
      if (typeof who.user_id !== 'string') throw new Error('Matrix 用户身份无效')
      const state = await this.request(`/_matrix/client/v3/rooms/${target}/state`, signal)
      if (!Array.isArray(state)) throw new Error('Matrix 房间状态无效')
      if (state.some(e => e.type === 'm.room.encryption')) throw new Error('首版不支持 Matrix 加密房间，请使用未加密双人房间')
      const members = state.filter(e => e.type === 'm.room.member' && e.content?.membership === 'join').map(e => e.state_key)
      if (members.length !== 2 || !members.includes(who.user_id) || members.some(id => typeof id !== 'string')) throw new Error('Matrix 房间必须只有机器人和一位已加入的联系人')
      this.botId = who.user_id; this.peerId = members.find(id => id !== this.botId)!
    } else {
      const who = await this.request('/api/v4/users/me', signal)
      const room = await this.request(`/api/v4/channels/${target}`, signal)
      const members = await this.request(`/api/v4/channels/${target}/members?page=0&per_page=3`, signal)
      if (typeof who.id !== 'string' || room.type !== 'D' || !Array.isArray(members) || members.length !== 2 || !members.some(m => m.user_id === who.id)) throw new Error('Mattermost 目标必须是机器人已加入的双人 DM，不能是群组或公开频道')
      const peer = members.find(m => m.user_id !== who.id)?.user_id
      if (typeof peer !== 'string') throw new Error('Mattermost 联系人无效')
      this.botId = who.id; this.peerId = peer
    }
    if(this.expected && (this.expected.accountId!==this.botId||this.expected.peerId!==this.peerId))throw new Error('机器人或会话成员已变化，请重新配置，禁止沿用旧会话权限')
    return {accountId: this.botId, peerId: this.peerId}
  }

  async poll(cursor: string | undefined, signal: AbortSignal): Promise<DirectBatch> {
    await this.validate(signal)
    if(!this.config.targetId)return pollDiscovered(this.config.platform,this.botId,cursor,signal,
      (path,body)=>this.request(path,signal,body),
      targetId=>new DirectTransport({...this.config,targetId},this.token))
    if (this.config.platform === 'matrix') {
      const filter = JSON.stringify({room:{rooms:[this.config.targetId],timeline:{limit:100}},presence:{types:[]}})
      const data = await this.request('/_matrix/client/v3/sync?timeout=20000&filter='+encodeURIComponent(filter)+(cursor ? '&since='+encodeURIComponent(cursor) : ''), signal)
      if (typeof data.next_batch !== 'string') throw new Error('Matrix 同步游标缺失')
      const room = data.rooms?.join?.[this.config.targetId]
      if (cursor && room?.timeline?.limited) throw new Error('Matrix 消息出现缺口，已暂停以免跳过未处理消息')
      const messages: DirectMessage[] = []
      // First sync establishes a watermark, never executes historical messages.
      for (const event of cursor ? room?.timeline?.events ?? [] : []) {
        if (event.sender !== this.peerId || event.type !== 'm.room.message' || event.content?.['m.relates_to']?.rel_type === 'm.replace') continue
        if (typeof event.event_id !== 'string') continue
        if (event.content?.msgtype !== 'm.text' || typeof event.content.body !== 'string') {
          messages.push({id:event.event_id,sender:this.peerId,text:''}); continue
        }
        messages.push({id:event.event_id,sender:this.peerId,text:event.content.body})
      }
      return {cursor:data.next_batch,messages}
    }
    const data = await this.request(`/api/v4/channels/${encodeURIComponent(this.config.targetId)}/posts?per_page=200`+(cursor ? '&since='+encodeURIComponent(cursor) : ''), signal)
    if (!Array.isArray(data.order) || !data.posts) throw new Error('Mattermost 消息响应无效')
    if (cursor && data.order.length >= 200) throw new Error('Mattermost 消息积压超出单批上限，已暂停以免遗漏')
    const posts = data.order.map((id: string) => data.posts[id]).filter((p: any) => p && Number.isFinite(p.create_at)).sort((a:any,b:any)=>a.create_at-b.create_at)
    const next = Math.max(Number(cursor ?? 0), ...posts.map((p:any)=>p.create_at))
    return {cursor:String(next),messages:cursor ? posts.filter((p:any)=>p.user_id===this.peerId && !p.type && !p.delete_at && !p.root_id).map((p:any)=>({id:p.id,sender:this.peerId,text:Array.isArray(p.file_ids)&&p.file_ids.length?'':p.message ?? ''})) : []}
  }

  async sendText(userId: string, text: string, _context: string | undefined, signal?: AbortSignal): Promise<void> {
    if(!this.config.targetId)throw new Error('联系人尚未配对，不能投递')
    await this.validate(signal)
    if (userId !== this.peerId) throw new Error('目标联系人与当前双人会话不匹配，拒绝投递')
    for (let offset=0; offset<text.length; offset+=4000) {
      const content=text.slice(offset,offset+4000)
      if (this.config.platform==='matrix') await this.request(`/_matrix/client/v3/rooms/${encodeURIComponent(this.config.targetId)}/send/m.room.message/${randomUUID()}`,signal,{msgtype:'m.text',body:content},'PUT')
      else await this.request('/api/v4/posts',signal,{channel_id:this.config.targetId,message:content})
    }
  }
  async sendAttachment(_userId: string, _file: PartnerOutboundAttachment, _context: string | undefined, _signal?: AbortSignal): Promise<void> {
    throw new Error('Matrix / Mattermost 首版仅支持文本，附件尚未交付；请在 DSH 工作区查看文件')
  }
}
