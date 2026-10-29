import { QQ_ACTION_MAP } from './action-catalog.js'
export interface QqSettings {
  identityBinding: { enabled: boolean; qqIds?: string[]; /** Legacy single-account input. */ qqId?: string }
  replyVoiceEnabled?: boolean
  replyVoiceGroupId?: string
  autonomousActions: boolean
  enabledActions: string[]
  qzoneVisibility: 1 | 4 | 64
  voiceCharacter: string
  privateReplies: boolean
  groupReplies: boolean
  groupIds: string[]
  mainSessionPeers: string[]
  autonomousGroupIds: string[]
  stickerSource: 'channel' | 'default'
  groupTrigger: 'mention' | 'all'
  mentionSender: boolean
  facesEnabled: boolean
  imagesEnabled: boolean
}
export const DEFAULT_QQ_SETTINGS: QqSettings = { replyVoiceEnabled:false,replyVoiceGroupId:'', identityBinding:{enabled:false,qqIds:[]}, autonomousActions:false, enabledActions:[], qzoneVisibility:4, voiceCharacter:'', privateReplies:true, groupReplies:false, groupIds:[], mainSessionPeers:[], autonomousGroupIds:[], stickerSource:'channel', groupTrigger:'mention', mentionSender:true, facesEnabled:true, imagesEnabled:true }
export function boundQqIds(value?: QqSettings['identityBinding']): string[] {
  if (value?.enabled === false) return []
  const ids = value?.qqIds ?? (value?.qqId ? [value.qqId] : [])
  return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && validQqId(id.trim())).map(id => id.trim()))].slice(0, 100) : []
}
export function qqSettings(value?: Partial<QqSettings>): QqSettings {
  const qqIds = boundQqIds(value?.identityBinding)
  return {...DEFAULT_QQ_SETTINGS,...value,replyVoiceEnabled:value?.replyVoiceEnabled ?? Boolean(value?.autonomousActions && value?.enabledActions?.includes('send_group_ai_record')),replyVoiceGroupId:value?.replyVoiceGroupId ?? '',identityBinding:{enabled:qqIds.length>0,qqIds},enabledActions:[...(value?.enabledActions??[])],groupIds:[...(value?.groupIds??[])],mainSessionPeers:[...(value?.mainSessionPeers??[])],autonomousGroupIds:[...(value?.autonomousGroupIds??[])]}
}
export function parseQqSettings(value: unknown): QqSettings {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('QQ 设置格式无效')
  const v=value as Record<string,unknown>
  for (const key of ['privateReplies','groupReplies','mentionSender','facesEnabled','imagesEnabled']) if(typeof v[key]!=='boolean')throw Error('QQ 开关设置无效')
  if(v.groupTrigger!=='mention'&&v.groupTrigger!=='all')throw Error('请选择群聊触发方式')
  if(!Array.isArray(v.groupIds)||v.groupIds.length>100||v.groupIds.some(id=>typeof id!=='string'||!validQqId(id)))throw Error('群号列表无效（最多 100 个群）')
  const peers=v.mainSessionPeers??[]
  if(!Array.isArray(peers)||peers.length>100||peers.some(peer=>typeof peer!=='string'||! /^(private|group):[1-9]\d{4,15}$/.test(peer)||!validQqId(peer.split(':')[1]!)))throw Error('主会话对象列表无效（最多 100 个用户或群）')
  const autonomous=v.autonomousGroupIds??[]
  if(!Array.isArray(autonomous)||autonomous.length>100||autonomous.some(id=>!(v.groupIds as string[]).includes(id)))throw Error('自主回复白名单必须从已选群组中选择')
  if(v.stickerSource!==undefined&&v.stickerSource!=='channel'&&v.stickerSource!=='default')throw Error('请选择表情来源')
  if(v.autonomousActions!==undefined&&typeof v.autonomousActions!=='boolean')throw Error('自主能力开关无效')
  const actions=v.enabledActions??[]
  if(!Array.isArray(actions)||actions.length>100||actions.some(id=>typeof id!=='string'||!QQ_ACTION_MAP.has(id)))throw Error('自主能力列表无效')
  if(v.qzoneVisibility!==undefined&&![1,4,64].includes(v.qzoneVisibility as number))throw Error('空间默认可见范围无效')
  if(v.voiceCharacter!==undefined&&(typeof v.voiceCharacter!=='string'||v.voiceCharacter.length>200))throw Error('默认音色无效')
  if(v.replyVoiceEnabled!==undefined&&typeof v.replyVoiceEnabled!=='boolean')throw Error('语音回复开关无效')
  if(v.replyVoiceGroupId!==undefined&&(typeof v.replyVoiceGroupId!=='string'||(v.replyVoiceGroupId!==''&&!(v.groupIds as string[]).includes(v.replyVoiceGroupId))))throw Error('语音来源群须在已接入群中')
  const binding=v.identityBinding??{enabled:false,qqId:''}
  if(!binding||typeof binding!=='object'||Array.isArray(binding))throw Error('身份关系绑定格式无效')
  const relation=binding as Record<string,unknown>
  if(relation.enabled!==undefined&&typeof relation.enabled!=='boolean')throw Error('归属账号开关无效')
  const rawIds=relation.qqIds??(typeof relation.qqId==='string'?(relation.qqId.trim()?[relation.qqId.trim()]:[]):[])
  if((relation.qqId!==undefined&&typeof relation.qqId!=='string')||!Array.isArray(rawIds)||rawIds.length>100||rawIds.some(id=>typeof id!=='string'||(id.trim()!==''&&!validQqId(id.trim()))))throw Error('请填写有效的归属 QQ 号，最多 100 个')
  const qqIds=relation.enabled===false?[]:[...new Set((rawIds as string[]).map(id=>id.trim()).filter(Boolean))]
  const enabled=qqIds.length>0
  return {replyVoiceEnabled:v.replyVoiceEnabled ?? Boolean(v.autonomousActions && (actions as string[]).includes('send_group_ai_record')),replyVoiceGroupId:v.replyVoiceGroupId??'',identityBinding:{enabled,qqIds},autonomousActions:v.autonomousActions??false,enabledActions:[...new Set(actions)],qzoneVisibility:v.qzoneVisibility??4,voiceCharacter:v.voiceCharacter??'',mainSessionPeers:[...new Set(peers)],autonomousGroupIds:[...new Set(autonomous)],stickerSource:v.stickerSource??'channel',privateReplies:v.privateReplies,groupReplies:v.groupReplies,mentionSender:v.mentionSender,facesEnabled:v.facesEnabled,imagesEnabled:v.imagesEnabled,groupTrigger:v.groupTrigger,groupIds:[...new Set(v.groupIds)]} as QqSettings
}
export function validQqId(id: string): boolean { return /^[1-9]\d{4,15}$/.test(id)&&Number.isSafeInteger(Number(id)) }
export function qqGroupPeer(value: string): {groupId:string;userId:string}|undefined {
  const m=/^group:(\d+):(\d+)$/.exec(value)
  return m&&validQqId(m[1]!)&&validQqId(m[2]!)?{groupId:m[1]!,userId:m[2]!}:undefined
}
export function qqPeerLabel(value: string): string { const peer=qqGroupPeer(value);return peer?`群 ${peer.groupId} · QQ ${peer.userId}`:value }
export function qqGroupRoute(route: {userId:string;channelId:string}, channels: readonly {id:string;platform?:string}[]): boolean {
  return !!qqGroupPeer(route.userId)&&channels.some(c=>c.id===route.channelId&&c.platform==='qq')
}

export function qqSessionTarget(userId:string):string { const group=qqGroupPeer(userId);return group?`group:${group.groupId}`:`private:${userId}` }
