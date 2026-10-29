import { OneBotConnection, OneBotError } from './connection.js'
import { oneBotMessage, qqId } from './message.js'
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
    || ['c2c.qpic.cn', 'gzc-download.ftn.qq.com', 'sz-download.ftn.qq.com'].includes(url.hostname)
  if (!known || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && !['80','443'].includes(url.port)) throw new Error('QQ 附件地址不属于受支持的媒体下载服务')
  return url
}

export class OneBotTransport {
  readonly connection: OneBotConnection
  constructor(readonly config: DirectConfig, token: string, private readonly expected?: {accountId: string; peerId: string}, connection?: OneBotConnection) {
    this.connection = connection ?? new OneBotConnection(config.baseUrl, token)
  }

  async validate(signal = AbortSignal.timeout(30000)): Promise<{accountId: string; peerId: string}> {
    const who = await this.connection.call('get_login_info', {}, signal)
    const accountId = qqId(who?.user_id)
    if (!accountId || this.expected && accountId !== this.expected.accountId) throw new OneBotError('QQ 登录账号无效或已变化，请重新配置渠道', false)
    const status = await this.connection.call('get_status', {}, signal)
    if (status?.online !== true || status?.good === false) throw new OneBotError('SnowLuma QQ 尚未上线，请先在远程桌面登录')
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
    const messages = events.map(event => oneBotMessage(event, identity.accountId, this.config.targetId)).filter((event): event is DirectMessage => Boolean(event))
    return {cursor: 'onebot-live', messages}
  }

  async sendText(userId: string, text: string, signal?: AbortSignal, authorize?: () => void): Promise<void> {
    if (!text.trim()) return
    await this.recipient(userId, signal)
    // QQ receives plain text segments. CQ-looking model output cannot become an action.
    const chars = Array.from(text)
    for (let offset = 0; offset < chars.length; offset += 3000) {
      authorize?.()
      const result = await this.connection.call('send_private_msg', {user_id: Number(userId), message: [{type: 'text', data: {text: chars.slice(offset, offset + 3000).join('')}}]}, signal)
      if (!result || !['string','number'].includes(typeof result.message_id)) throw new OneBotError('QQ 未确认文本发送结果', false)
    }
  }

  private async recipient(userId: string, signal?: AbortSignal): Promise<void> {
    const identity = await this.validate(signal)
    if (!this.config.targetId || identity.peerId !== userId) throw new OneBotError('QQ 消息接收人与已授权联系人不匹配', false)
  }

  async sendAttachment(userId: string, file: PartnerOutboundAttachment, signal: AbortSignal, allowed: () => boolean): Promise<void> {
    if (!allowed()) throw Error('渠道或联系人授权已撤销')
    await this.recipient(userId, signal)
    const data = await readOutboundMedia(file, signal)
    if (!allowed()) throw Error('渠道或联系人授权已撤销')
    const image = imageType(data)
    if (image) {
      const sent = await this.connection.call('send_private_msg', {user_id: Number(userId), message: [{type:'image', data:{file:'base64://'+data.toString('base64')}}]}, signal)
      if (!sent || !['string','number'].includes(typeof sent.message_id)) throw new OneBotError('QQ 未确认图片发送结果', false)
    } else {
      // SnowLuma accepts base64 uploads; container-local paths would point at the wrong host.
      const sent = await this.connection.call('upload_private_file', {user_id:Number(userId), file:'base64://'+data.toString('base64'), name:safeMediaName(file.name, '附件.bin')}, signal)
      if (typeof sent?.file_id !== 'string' || !sent.file_id) throw new OneBotError('QQ 未确认文件发送结果', false)
    }
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
      const response = await fetch(qqMediaUrl(ref.source), {signal, redirect:'error'})
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
      result.push({data, name:safeMediaName(ref.name ?? '', type ? 'QQ图片.'+type.split('/')[1] : 'QQ附件.bin'), kind:type?'image':'file', mediaType:type ?? (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(rawType)?rawType:'application/octet-stream')})
    }
    return result
  }
}
