import { qqGroupPeer, qqSettings } from './settings.js'
import { OneBotConnection, OneBotError } from './connection.js'
import { oneBotMessage, qqId } from './message.js'
import type {DirectMedia} from '../direct/media.js'
import type { DirectBatch, DirectConfig, DirectMessage } from '../direct/transport.js'
import { imageType, readOutboundMedia } from '../direct/media.js'
import { PARTNER_MEDIA_MAX_BYTES, safeMediaName, type PartnerInboundAttachment, type PartnerOutboundAttachment } from '../../channel-message.js'

/** Only public QQ media hosts; never forward the OneBot token to media URLs. */
export function qqMediaUrl(source: string): URL {
  let url: URL
  try { url = new URL(source) } catch { throw new Error('QQ 附件没有可下载地址，请重新发送原图或文件') }
  const domains = ['qpic.cn', 'gtimg.cn', 'multimedia.nt.qq.com']
  // qq.com is restricted to known download services, not arbitrary QQ links.
  const known = domains.some(host => url.hostname === host || url.hostname.endsWith('.' + host))
    || ['c2c.qpic.cn', 'gzc-download.ftn.qq.com', 'sz-download.ftn.qq.com', 'multimedia.nt.qq.com.cn'].includes(url.hostname)
  if (!known || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80','443'].includes(url.port)) throw new Error('QQ 附件地址不属于受支持的媒体下载服务')
  return url
}

export class OneBotTransport {
  readonly connection: OneBotConnection
  constructor(readonly config: DirectConfig, token: string, private readonly expected?: {accountId: string; peerId: string}, connection?: OneBotConnection) {
    this.connection = connection ?? new OneBotConnection(config.baseUrl, token)
  }

  async validate(signal = AbortSignal.timeout(30000)): Promise<{accountId: string; peerId: string}> {
    // Independent read-only checks share one round trip; all must pass before delivery.
    const [who,status] = await Promise.all([this.connection.call('get_login_info', {}, signal),this.connection.call('get_status', {}, signal)])
    const accountId = qqId(who?.user_id)
    if (!accountId || this.expected && accountId !== this.expected.accountId) throw new OneBotError('QQ 登录账号无效或已变化，请重新配置渠道', false)
    if (status?.online !== true || status?.good === false) throw new OneBotError('SnowLuma QQ 尚未上线，请先在远程桌面登录')
    const group=this.config.targetId.startsWith('group:')?this.config.targetId.slice(6):undefined
    if(group) {
      const member=qqGroupPeer(this.expected?.peerId??'')
      const policy=qqSettings(this.config.qq)
      if(!qqId(group)||!member||member.groupId!==group||!policy.groupReplies||!policy.groupIds.includes(group))throw new OneBotError('群回复未开启或目标群未授权',false)
      const [groups,info]=await Promise.all([this.connection.call('get_group_list',{},signal),this.connection.call('get_group_member_info',{group_id:Number(group),user_id:Number(member.userId)},signal)])
      if(!Array.isArray(groups)||!groups.some(g=>qqId(g.group_id)===group))throw new OneBotError('机器人已不在目标群中',false)
      if(qqId(info?.user_id)!==member.userId||qqId(info?.group_id)!==group)throw new OneBotError('群成员身份已变化',false)
      return {accountId,peerId:this.expected!.peerId}
    }
    const peerId = this.config.targetId
    if (peerId) {
      if (!qqId(peerId) || peerId === accountId) throw new OneBotError('QQ 联系人号码无效', false)
      const friends = await this.connection.call('get_friend_list', {}, signal)
      if (!Array.isArray(friends) || !friends.some(friend => qqId(friend?.user_id) === peerId)) throw new OneBotError('目标 QQ 不在好友列表中，请先添加好友', false)
      if (this.expected?.peerId && this.expected.peerId !== peerId) throw new OneBotError('QQ 联系人身份已变化', false)
    }
    return {accountId, peerId}
  }

  async poll(signal: AbortSignal, waitMs: number): Promise<DirectBatch> {
    const identity = await this.validate(signal)
    const events = await this.connection.read(signal, waitMs)
    const messages = events.map(event => oneBotMessage(event, identity.accountId, this.config.targetId, qqSettings(this.config.qq))).filter((event): event is DirectMessage => Boolean(event))
    for(const message of messages){
      const group=message.qqGroup
      if(group?.replyToId){const target=this.connection.quotedTarget(group.groupId,group.replyToId,identity.accountId);if(target)group.replyTo=target}
    }
    return {cursor: 'onebot-live', messages}
  }

  async sendText(userId: string, text: string, signal?: AbortSignal, authorize?: () => void): Promise<void> {
    if (!text.trim()) return
    await this.recipient(userId, signal)
    // QQ receives plain text segments. CQ-looking model output cannot become an action.
    const chars = Array.from(text)
    for (let offset = 0; offset < chars.length; offset += 3000) {
      authorize?.()
      const result = await this.connection.call(this.sendAction(userId), {...this.destination(userId), message: [...(offset===0?this.mention(userId):[]),{type: 'text', data: {text: chars.slice(offset, offset + 3000).join('')}}]}, signal)
      if (!result || !['string','number'].includes(typeof result.message_id)) throw new OneBotError('QQ 未确认文本发送结果', false)
    }
  }

  private async recipient(userId: string, signal?: AbortSignal): Promise<void> {
    const identity = await this.validate(signal)
    if(!qqGroupPeer(userId)&&!qqSettings(this.config.qq).privateReplies)throw new OneBotError('私聊回复已关闭',false)
    if (!this.config.targetId || identity.peerId !== userId) throw new OneBotError('QQ 消息接收人与已授权联系人不匹配', false)
  }

  async sendAttachment(userId: string, file: PartnerOutboundAttachment, signal: AbortSignal, allowed: () => boolean): Promise<void> {
    if (!allowed()) throw Error('渠道或联系人授权已撤销')
    await this.recipient(userId, signal)
    const data = await readOutboundMedia(file, signal)
    if (!allowed()) throw Error('渠道或联系人授权已撤销')
    const image = imageType(data)
    if (image) {
      if(!qqSettings(this.config.qq).imagesEnabled)throw new OneBotError('QQ 图片与表情包发送已关闭',false)
      const sent = await this.connection.call(this.sendAction(userId), {...this.destination(userId), message: [{type:'image', data:{file:'base64://'+data.toString('base64')}}]}, signal)
      if (!sent || !['string','number'].includes(typeof sent.message_id)) throw new OneBotError('QQ 未确认图片发送结果', false)
    } else {
      // SnowLuma accepts base64 uploads; container-local paths would point at the wrong host.
      const sent = await this.connection.call(qqGroupPeer(userId)?'upload_group_file':'upload_private_file', {...this.destination(userId), file:'base64://'+data.toString('base64'), name:safeMediaName(file.name, '附件.bin')}, signal)
      if (typeof sent?.file_id !== 'string' || !sent.file_id) throw new OneBotError('QQ 未确认文件发送结果', false)
    }
  }

  private sendAction(userId:string): string { return qqGroupPeer(userId)?'send_group_msg':'send_private_msg' }
  private destination(userId:string): Record<string,number> {
    const group=qqGroupPeer(userId)
    return group?{group_id:Number(group.groupId)}:{user_id:Number(userId)}
  }
  private mention(userId:string): unknown[] {
    const group=qqGroupPeer(userId)
    return group&&qqSettings(this.config.qq).mentionSender?[{type:'at',data:{qq:group.userId}},{type:'text',data:{text:' '}}]:[]
  }
  async sendCustomFace(userId:string,emojiId:string,signal:AbortSignal,authorize:()=>void):Promise<void> {
    if(!qqSettings(this.config.qq).imagesEnabled)throw new OneBotError('QQ 图片与表情包发送已关闭',false)
    if(!emojiId||emojiId.length>512||/[\x00-\x1f]/.test(emojiId))throw new OneBotError('QQ 收藏表情标识无效',false)
    await this.recipient(userId,signal);authorize()
    const sent=await this.connection.call('send_custom_face',{...this.destination(userId),emoji_id:emojiId},signal)
    if(!sent||!['string','number'].includes(typeof sent.message_id))throw new OneBotError('QQ 未确认收藏表情发送结果',false)
  }

  async sendFace(userId:string,faceId:string,signal:AbortSignal,authorize:()=>void):Promise<void> {
    if(!qqSettings(this.config.qq).facesEnabled)throw new OneBotError('QQ 系统表情发送已关闭',false)
    if(!/^\d{1,6}$/.test(faceId))throw new OneBotError('QQ 表情编号无效',false)
    await this.recipient(userId,signal);authorize()
    const sent=await this.connection.call(this.sendAction(userId),{...this.destination(userId),message:[...this.mention(userId),{type:'face',data:{id:faceId}}]},signal)
    if(!sent||!['string','number'].includes(typeof sent.message_id))throw new OneBotError('QQ 未确认表情发送结果',false)
  }

  async receiveAttachments(message: DirectMessage, signal: AbortSignal, allowed: () => boolean, maxBytes = PARTNER_MEDIA_MAX_BYTES): Promise<PartnerInboundAttachment[]> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PARTNER_MEDIA_MAX_BYTES) throw Error('附件大小限制无效')
    const refs = message.media ?? []
    if (refs.length > 8) throw Error('单条消息最多接收 8 个附件')
    const result: PartnerInboundAttachment[] = []
    let total = 0
    for (const ref of refs) {
      if (!allowed()) throw Error('渠道或联系人授权已撤销')
      await this.recipient(message.sender, signal)
      if (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > maxBytes - total)) throw Error('QQ 附件超过大小限制')
      let source=ref.source
      if(!source&&ref.kind==='file'&&ref.fileId){
        const group=qqGroupPeer(message.sender)
        const resolved=await this.connection.call(group?'get_group_file_url':'get_private_file_url',group?{group_id:Number(group.groupId),file_id:ref.fileId,...(ref.busid!==undefined?{busid:ref.busid}:{})}:{user_id:Number(message.sender),file_id:ref.fileId,file_hash:ref.fileHash??''},signal)
        if(!allowed())throw Error('渠道或联系人授权已撤销')
        if(typeof resolved?.url!=='string'||!resolved.url)throw Error('QQ 文件下载地址暂不可用')
        source=resolved.url
      }
      let refreshed=false
      if(!source&&ref.qq&&ref.kind!=='file'){source=await this.refreshMedia(message,ref,signal,allowed);refreshed=true}
      let response = await fetch(qqMediaUrl(source), {signal, redirect:'error'})
      if([403,404].includes(response.status)&&ref.qq&&ref.kind!=='file'&&!refreshed){
        await response.body?.cancel()
        source=await this.refreshMedia(message,ref,signal,allowed)
        response=await fetch(qqMediaUrl(source),{signal,redirect:'error'})
      }
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes - total) {
        await response.body?.cancel(); throw Error('QQ 附件无法下载或超过大小限制')
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.length
        if (total > maxBytes) throw Error('QQ 附件总大小超过限制')
        chunks.push(chunk)
      }
      if (!allowed()) throw Error('渠道或联系人授权已撤销')
      const data = Buffer.concat(chunks), type = imageType(data)
      const rawType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      const fallbackType=ref.kind==='video'?'video/mp4':'application/octet-stream'
      result.push({data, name:safeMediaName(ref.name ?? '', type ? 'QQ图片.'+type.split('/')[1] : ref.kind==='video'?'QQ视频.mp4':'QQ附件.bin'), kind:type?'image':'file', mediaType:type ?? (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawType)&&rawType!=='application/octet-stream'?rawType:fallbackType)})
    }
    return result
  }

  private async refreshMedia(message:DirectMessage,ref:DirectMedia,signal:AbortSignal,allowed:()=>boolean):Promise<string>{
    if(!allowed())throw Error('渠道或联系人授权已撤销')
    const origin=ref.qq!
    const raw=await this.connection.call('get_msg',{message_id:origin.messageId},signal)
    if(!allowed())throw Error('渠道或联系人授权已撤销')
    const group=qqGroupPeer(message.sender),sender=qqId(raw?.sender?.user_id??raw?.user_id)
    const sameRoom=group?raw?.message_type==='group'&&String(raw.group_id)===group.groupId:raw?.message_type==='private'&&(sender===message.sender&&(raw.target_id===undefined||String(raw.target_id)===this.expected?.accountId)||sender===this.expected?.accountId&&String(raw.target_id)===message.sender)
    if(String(raw?.message_id)!==String(origin.messageId)||sender!==origin.senderId||!sameRoom)throw Error('无法核对附件原消息所属会话')
    const segment=raw.message?.[origin.index]
    if(segment?.type!==ref.kind||typeof segment.data?.url!=='string'||!segment.data.url)throw Error('QQ 原消息未返回可下载附件地址')
    return segment.data.url
  }
}
