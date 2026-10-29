import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../../store.js'
import { questionOrigin } from '../question-origin.js'
import { isIdleContactNotice } from '../../character/idle-contact.js'
import { qqSettings, qqGroupPeer } from './settings.js'
import { qqMediaUrl } from './transport.js'
import type { QqActionCall } from './actions.js'

/** Conversation-only voice delivery: no target, file, URL or arbitrary API arguments. */
export function qqReplyTool(owner: string, store: PartnerStore, call: QqActionCall): ToolDefinition {
  return {
    name: 'partner_qq_reply',
    description: '向当前 QQ 聊天对象回复语音。voices 查询当前可用音色；voice 把 text 转成语音并发送，成功后结束回合，不重复发文字。无需填写接收人；不能读取本地文件、转发到其他联系人或使用 QQ 空间/管理能力。语音是否可用由渠道的聊天回复设置控制。普通文字和表情仍使用 partner_chat_reply 或最终正文。',
    parameters: { type:'object', additionalProperties:false, required:['action'], properties:{
      action:{type:'string',enum:['voices','voice']}, text:{type:'string',minLength:1,maxLength:2000}, character:{type:'string',minLength:1,maxLength:200},
    }},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    presentCall:()=>({card:'generic',title:'QQ 语音回复'}),
    async execute(raw, exec) {
      const args=raw as {action:string;text?:string;character?:string}
      if (!args || Object.keys(args).some(k=>!['action','text','character'].includes(k)) || !['voices','voice'].includes(args.action)) throw Error('语音回复参数无效')
      if(args.action==='voice' && (typeof args.text!=='string'||!args.text.trim()||args.text.length>2000))throw Error('请提供 1–2000 字的语音内容')
      if(args.character!==undefined && (typeof args.character!=='string'||!args.character.trim()||args.character.length>200))throw Error('音色标识无效')
      const agent=exec.agent
      if(!agent)throw Error('需要当前 QQ 会话')
      const origin=()=>{
        const state=store.snapshot(),events=agent.session.snapshotEvents()
        const latest=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)))
        const route=latest&&isIdleContactNotice(latest)
          ? state.sessions.find(r=>r.sessionId===agent.session.id&&latest.type==='user/message'&&r.idleContactState?.messageId===latest.data.id)
          : questionOrigin(agent.session.id,events,state.sessions)
        return {state,route,messageId:latest?.type==='user/message'?latest.data.id:undefined}
      }
      const initial=origin(),route=initial.route
      const channel=initial.state.channels.find(c=>c.id===route?.channelId&&c.companionId===owner&&c.platform==='qq')
      if(!route||route.companionId!==owner||!channel)throw Error('只能回复本轮实际来自的 QQ 会话')
      const group=qqGroupPeer(route.userId)
      const guard=()=>{
        exec.signal.throwIfAborted()
        const now=origin(),current=now.state.channels.find(c=>c.id===channel.id),settings=qqSettings(current?.qq)
        if(store.isCompanionRemoving(owner)||now.route?.id!==route.id||now.messageId!==initial.messageId||!current?.enabled||current.updatedAt!==channel.updatedAt||!settings.replyVoiceEnabled)throw Error('语音回复已关闭，或当前对象/渠道配置已变化')
        if(!now.state.pairings.some(p=>p.channelId===channel.id&&p.userId===route.userId&&p.status==='approved'&&(!p.directTargetId||p.directTargetId===(group?'group:'+group.groupId:route.userId))))throw Error('当前联系人访问许可已撤回')
        if(group ? !settings.groupReplies||!settings.groupIds.includes(group.groupId) : !settings.privateReplies)throw Error('当前会话回复已关闭')
        return settings
      }
      const settings=guard()
      const sourceGroup=group?.groupId||settings.replyVoiceGroupId||settings.groupIds[0]
      if(!sourceGroup||!settings.groupIds.includes(sourceGroup))throw Error('请在聊天回复中选择可用的 QQ 音色来源群')
      const signal=AbortSignal.any([exec.signal,AbortSignal.timeout(60000)])
      const voices=async()=>{
        const result=await call(channel.id,'get_ai_characters',{group_id:Number(sourceGroup),chat_type:1},signal,()=>{guard()})
        guard()
        return Array.isArray(result)?result.flatMap(row=>Array.isArray(row?.characters)?row.characters.filter((v:any)=>typeof v.character_id==='string'&&typeof v.character_name==='string').map((v:any)=>({id:v.character_id,name:v.character_name})):[]).slice(0,100):[]
      }
      if(args.action==='voices')return {voices:await voices()}
      if(typeof exec.concludeTurn!=='function'||!exec.callId)throw Error('当前宿主不支持语音回复终结')
      const character=args.character?.trim()||settings.voiceCharacter||(await voices())[0]?.id
      if(!character)throw Error('当前没有可用音色，请选择音色或改用文字')
      const receiptId=createHash('sha256').update(JSON.stringify(['reply-voice',owner,agent.session.id,exec.callId])).digest('hex')
      let previous:string|undefined
      await store.update(state=>{
        guard()
        const current=state.channels.find(c=>c.id===channel.id)!
        const log=current.qqActivity??=[]
        previous=log.find(r=>r.id===receiptId)?.status
        if(!previous)log.push({id:receiptId,action:'reply_voice',at:Date.now(),status:'pending'})
      })
      if(previous){if(previous==='confirmed')exec.concludeTurn();return {status:previous,resent:false}}
      try {
        guard()
        let result:any
        if(group)result=await call(channel.id,'send_group_ai_record',{group_id:Number(group.groupId),character,text:args.text!.trim(),chat_type:1},signal,()=>{guard()})
        else {
          const generated=await call(channel.id,'get_ai_record',{group_id:Number(sourceGroup),character,text:args.text!.trim(),chat_type:1},signal,()=>{guard()})
          if(typeof generated!=='string')throw Error('未取得生成语音')
          // Only a trusted QQ-generated media URL, never a caller supplied file/URL.
          const url=qqMediaUrl(generated).href
          guard()
          result=await call(channel.id,'send_private_msg',{user_id:Number(route.userId),message:[{type:'record',data:{file:url}}]},signal,()=>{guard()})
        }
        if(!result||!['string','number'].includes(typeof result.message_id)||!String(result.message_id)||Number(result.message_id)===0)throw Error('QQ 未确认语音发送')
        await store.update(state=>{const receipt=state.channels.find(c=>c.id===channel.id)?.qqActivity?.find(r=>r.id===receiptId);if(receipt)receipt.status='confirmed'})
        exec.concludeTurn()
        return {status:'confirmed',spokenText:args.text!.trim(),messageId:String(result.message_id)}
      } catch {
        await store.update(state=>{const receipt=state.channels.find(c=>c.id===channel.id)?.qqActivity?.find(r=>r.id===receiptId);if(receipt&&receipt.status!=='confirmed')receipt.status='unknown'})
        throw Error('语音未确认发送，请查看 QQ 实际结果；不要自动重复发送。')
      }
    },
  }
}
