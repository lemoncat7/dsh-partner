import {supportsChannelTts} from '../voice/domain.js'
import {biliActivityProvider} from './bilibili/activity-provider.js'
import { ChannelActivityRegistry } from './activity-registry.js'
import { qqActivityProvider } from './qq/activity-provider.js'

/** Transport-independent conversation capability plus channel-specific providers. */
export function createChannelActivities(onError?: (provider:string,error:unknown)=>void): ChannelActivityRegistry {
  const registry = new ChannelActivityRegistry(onError)
  registry.register({id:'conversation',platform:'*',discover:({sessions})=>sessions.length ? [{
    id:'conversation',title:'与已授权会话交流',tool:'partner_chat_reply',visibility:'public',
    description:'有想分享的内容时，可通过 partner_thoughts 查看已授权目标并安排对应会话的后续活动；partner_chat_reply 只回复当前活动会话，不因本目录而转发到其他渠道。文字、分段和表情沿用渠道设置。',
  }] : []})
  registry.register({id:'qq.expression',platform:'qq',discover:({sessions})=>sessions.length ? [
    {id:'stickers',title:'表情包收藏与表达',tool:'partner_stickers',visibility:'public',description:'通过 partner_tools 的 activity 目录查询、describe/call 表情包能力；按兴趣选择、收藏和整理，发送用 partner_chat_reply 的 stickerId。无需每次整理后分享。实际使用受当前会话和表情开关限制。'},

  ] : []})
  registry.register({id:'tts.expression',platform:'*',discover:({channel,sessions})=>sessions.length&&supportsChannelTts(channel.platform)?[{id:'voice',title:'语音表达',tool:'partner_voice_reply',visibility:'public',operations:['status','speak','send_file'],description:'通过 partner_tools describe/call 调用 send_file 发送脚本已生成的音频，不要求配置 TTS；已配置时也可 speak 合成。普通聊天和自主活动均可使用，只发送到当前会话；QQ 发语音条，其他消息渠道发音频附件，成功后不重复发送同样文字。'}]:[]})
  registry.register(qqActivityProvider)
  registry.register(biliActivityProvider)
  return registry
}
