import type {PartnerOutboundAttachment} from '../channel-message.js'
import {supportsChannelTts} from './domain.js'
import {directReplyTarget} from '../channels/reply-access.js'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import type {PartnerStore} from '../store.js'
import type {TtsService} from './service.js'
import type {QqActionCall} from '../channels/qq/actions.js'
import {qqGroupPeer,qqSettings} from '../channels/qq/settings.js'
import {channelReplyAllowed} from '../channels/reply-access.js'
import {questionOrigin} from '../channels/question-origin.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {OneBotApiError} from '../channels/qq/connection.js'
export function voiceReplyTool(owner:string,store:PartnerStore,service:TtsService,call:QqActionCall,sendAudio?:(sessionId:string,file:PartnerOutboundAttachment,signal:AbortSignal,routeId:string,guard:()=>void)=>Promise<void>):ToolDefinition {
 return {name:'partner_voice_reply',description:'使用伙伴「渠道 → TTS」中配置并分配给当前渠道的通用服务向当前聊天对象说话，属于公开聊天回复能力。action=status 查看当前语音服务和可用音色；action=send_file 用 path 发送脚本已生成的当前会话目录内 WAV/MP3（最多10MB），不合成、不改音色、不要求开启或选择 TTS 服务；可 continueTurn:true 连续发送试听，比较和记录音色由你自行完成。action=speak 将按当前人物写好的 text 合成并发送音频（QQ 为语音条，微信、Matrix、Mattermost 为音频附件），不重写语气。不能填写收件人、接口或密钥。默认送达后结束本轮；continueTurn:true 可接着执行或接话。成功后不重复发同样的文字；结果未知不能重试发送。未启用外部 TTS 时 QQ 原生语音仍可用 partner_qq_reply。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['status','speak','send_file']},path:{type:'string',minLength:1,maxLength:4096,description:'send_file 专用，本会话工作目录内已生成的音频路径'},text:{type:'string',minLength:1,maxLength:2000},voice:{type:'string',maxLength:200},continueTurn:{type:'boolean'}}},presentCall:()=>({card:'generic',title:'语音 TTS'}),
 output:{schema:{type:'object'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}],presentationMeta:(_a,v)=>{const r=v as any;return r.status==='confirmed'?{kind:'partner-chat-v1',parts:[],delivered:true,deliveryKind:'text',originRouteId:r.originRouteId,inputMessageId:r.inputMessageId,spokenText:r.spokenText,...(r.continueTurn?{intermediate:true}:{})}:null}},
 async execute(raw,exec){
  const a=raw as {action:string;path?:string;text?:string;voice?:string;continueTurn?:boolean}
  if(!a||Object.keys(a).some(k=>!['action','path','text','voice','continueTurn'].includes(k))||!['status','speak','send_file'].includes(a.action)||a.continueTurn!==undefined&&typeof a.continueTurn!=='boolean')throw Error('语音参数无效')
  const agent=exec.agent;if(!agent)throw Error('需要当前渠道会话')
  const origin=()=>{const events=agent.session.snapshotEvents(),state=store.snapshot();const latest=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)));const route=latest&&isIdleContactNotice(latest)?state.sessions.find(r=>r.sessionId===agent.session.id&&latest.type==='user/message'&&r.idleContactState?.messageId===latest.data.id):questionOrigin(agent.session.id,events,state.sessions);return {route,input:latest?.type==='user/message'?latest.data.id:undefined}}
  const initial=origin(),route=initial.route,c=store.snapshot().channels.find(c=>c.id===route?.channelId&&c.companionId===owner)
  if(!route||route.companionId!==owner||!initial.input||!c||!supportsChannelTts(c.platform))throw Error('当前会话不是支持语音 TTS 的消息渠道')
  const group=c.platform==='qq'?qqGroupPeer(route.userId):undefined
  const target=directReplyTarget(store.snapshot(),c.id,route.userId)
  const guard=()=>{exec.signal.throwIfAborted();const now=origin(),state=store.snapshot(),live=state.channels.find(x=>x.id===c.id),settings=qqSettings(live?.qq);if(store.isCompanionRemoving(owner)||!live?.enabled||live.updatedAt!==c.updatedAt||live.companionId!==owner||directReplyTarget(state,c.id,route.userId)!==target||now.input!==initial.input||now.route?.id!==route.id)throw Error('语音对象或渠道配置已变化');if(!channelReplyAllowed(state,c.id,route.userId,target||undefined))throw Error('当前会话许可已撤回');if(c.platform==='qq'&&(group?!settings.groupReplies||!settings.groupIds.includes(group.groupId):!settings.privateReplies))throw Error('当前会话回复已关闭')}
  guard()
  if(a.action==='status'){if(!c.tts?.enabled)return {enabled:false,sendFile:true,nativeQqVoice:c.platform==='qq'&&qqSettings(c.qq).replyVoiceEnabled===true};const p=service.profile(owner,c.tts.profileId);return {enabled:true,sendFile:true,delivery:c.platform==='qq'?'voice':'audio-attachment',provider:p.provider,voice:c.tts.voice||p.voice,name:p.name}}
  if(a.action==='send_file'&&(typeof a.path!=='string'||!a.path.trim()||a.path.length>4096||a.voice!==undefined||a.text!==undefined))throw Error('send_file 只需 path，可选 continueTurn；音色与内容由原音频决定')
  if(a.action!=='send_file'&&a.path!==undefined)throw Error('只有 send_file 接受音频文件路径')
  if(a.action==='speak'&&!c.tts?.enabled)throw Error('渠道尚未开启语音 TTS')
  if(c.platform!=='qq'&&!sendAudio)throw Error('当前渠道音频发送未初始化')
  if(a.action==='speak'&&(typeof a.text!=='string'||!a.text.trim()||a.text.length>2000||a.voice!==undefined&&(typeof a.voice!=='string'||a.voice.length>200)))throw Error('请提供有效的语音正文和音色')
  if(!a.continueTurn&&typeof exec.concludeTurn!=='function')throw Error('当前宿主不支持语音终结')
  const input={owner,channelId:c.id,routeId:route.id,inputId:initial.input,text:a.text?.trim()??'',voice:a.voice,signal:exec.signal,guard,send:async(data:Buffer,signal:AbortSignal,check:()=>void,file:PartnerOutboundAttachment)=>{
   if(c.platform!=='qq'){await sendAudio!(agent.session.id,file,signal,route.id,check);return {confirmed:true as const}}
   try{const result=await call(c.id,group?'send_group_msg':'send_private_msg',{...(group?{group_id:Number(group.groupId)}:{user_id:Number(route.userId)}),message:[{type:'record',data:{file:'base64://'+data.toString('base64')}}]},signal,check) as any;return result&&['number','string'].includes(typeof result.message_id)?String(result.message_id):''}catch(e){if(e instanceof OneBotApiError)throw Object.assign(Error('渠道明确拒绝发送，可复用已生成音频'),{sendRejected:true});throw e}
  }}
  const cwd=route.cwd??agent.session.header?.cwd
  if(a.action==='send_file'&&!cwd)throw Error('当前会话缺少工作目录')
  const r=a.action==='send_file'?await service.deliverFile({...input,cwd:cwd!,path:a.path!}):await service.deliver(input)
  if(r.status!=='confirmed')throw Error('本次语音'+(r.status==='unknown'?'结果未知':'尚未确认送达')+'；不要自动重新合成或发送，请核对服务和渠道记录')
  if(!a.continueTurn)exec.concludeTurn()
  return {status:r.status,messageId:r.messageId,originRouteId:route.id,inputMessageId:initial.input,spokenText:r.spokenText,continueTurn:a.continueTurn===true}
 }}
}
