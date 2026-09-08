import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { PartnerStore } from '../store.js'
import type { ChannelManager } from '../channels/manager.js'
import { isInternalTaskNotice } from '../channels/delivery-policy.js'
import type { AttachmentDeliveryService } from './service.js'

export const ATTACHMENT_PROTOCOL = '交付图片或文档时，如果当前提供 partner_send_attachment，必须调用它，path 填生成工具返回的真实本地文件路径。普通 Markdown 链接仅是引用，不代表发送成功。工具会把指定文件显示在会话中，并在当前会话绑定渠道时发送真实附件；必须以工具返回的 channel 状态为准。失败用 deliveryId 重试原附件，无需重新生成。远端文件先下载到当前会话目录，不要编造 sandbox 地址。不要提交中间产物、内部核验材料或用户未要求交付的文件。工具完成后最终回复只简述结论，不要再次粘贴附件下载地址。若临时执行环境未提供此工具，只向负责人交回真实文件位置和结果，不得声称附件已发送。'

export function attachmentTool(companionId: string, store: PartnerStore, service: AttachmentDeliveryService, ctx: Context, channels: ChannelManager, prefix: string): ToolDefinition {
  return {
    name: 'partner_send_attachment', description: '明确交付一个图片或文档到当前伙伴会话及其绑定渠道。path 与 deliveryId 二选一；前者提交当前会话目录内真实文件（64 MB 内），后者重试已保存附件。不是文件检索工具，不自动下载 URL，不跨伙伴读取文件。内部看板执行/验收仅展示在会话，不向渠道逐项发送。',
    parameters: { type:'object', properties:{path:{type:'string'},deliveryId:{type:'string',description:'失败回执中的 ID；已成功的同一交付不会重复发送'}}, additionalProperties:false },
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}]},
    presentCall:()=>({card:'generic',title:'交付图片或文档'}),
    async execute(raw, exec) {
      const input = raw as {path?:unknown;deliveryId?:unknown}
      if (!input || typeof input !== 'object' || (typeof input.path === 'string') === (typeof input.deliveryId === 'string')) throw new Error('path 与 deliveryId 必须且只能提供一个')
      const agent = exec.agent
      if (!agent) throw new Error('附件交付需要当前伙伴会话')
      const sessionId = agent.session.id
      return service.serial(sessionId, async () => {
        exec.signal.throwIfAborted()
        const state=store.snapshot(), route=state.sessions.find(s=>s.sessionId===sessionId&&s.companionId===companionId)
        if (!route || !state.companions.some(c=>c.id===companionId) || store.isCompanionRemoving(companionId)) throw new Error('当前会话不属于有效伙伴，不能交付附件')
        const events=agent.session.snapshotEvents()
        const origin=[...events].reverse().find(e=>e.type==='user/message' && (e.data.source.kind==='user'||isInternalTaskNotice(e)))
        const internal = origin ? isInternalTaskNotice(origin) : true
        const channel = route.kind !== 'local' && !internal
        const cwd=route.cwd??agent.session.header.cwd
        if(!cwd)throw new Error('当前会话缺少工作目录')
        let item = typeof input.deliveryId==='string' ? service.get(input.deliveryId) : await service.serial('prepare',()=>service.prepare({companionId,sessionId,turn:origin?.seq??agent.session.seq,cwd,path:input.path as string,channel},exec.signal))
        if (!item || item.companionId!==companionId || item.sessionId!==sessionId) throw new Error('附件交付不存在或不属于当前伙伴会话')
        if (!channel && item.channel!=='none') throw new Error('当前执行不能向原渠道重发附件，请回到直接对话重试')
        if (channel && item.channel==='none' && typeof input.deliveryId==='string') throw new Error('这份附件原本仅供会话查看。若要正式发送到渠道，请使用 path 明确提交原文件')
        const url=`${prefix.replace(/\/$/,'')}/attachments/${item.id}`
        const escaped=item.name.replace(/[\[\]\\]/g,'_')
        const content: ContentBlock[]=[{type:'text',text:`[下载附件：${escaped}](${url})`}]
        if(item.kind==='image') {
          const ref=await ctx.attachments.saveImage({data:await service.bytes(item),mediaType:item.mediaType as ImageMediaType,name:item.name})
          content.push({type:'image',attachment:ref})
        }
        let error: string | undefined
        try { item=await service.deliver(item,file=>channels.sendExplicitAttachment(sessionId,file,exec.signal)) }
        catch (cause) { error=cause instanceof Error?cause.message:String(cause) }
        const status=item.channel==='sent'?'渠道附件已发送':item.channel==='none'?'仅交付到当前会话':`渠道发送未完成，请用 deliveryId 重试：${item.id}`
        content.push({type:'text',text:status})
        exec.deferContext(createUserMessage({source:{kind:'plugin',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴附件交付'},content}))
        return JSON.stringify({deliveryId:item.id,name:item.name,conversation:'attachment_recorded',channel:item.channel,...(error?{error,retry:{deliveryId:item.id}}:{})})
      })
    },
  }
}
