export interface QqSettings {
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
export const DEFAULT_QQ_SETTINGS: QqSettings = { privateReplies:true, groupReplies:false, groupIds:[], mainSessionPeers:[], autonomousGroupIds:[], stickerSource:'channel', groupTrigger:'mention', mentionSender:true, facesEnabled:true, imagesEnabled:true }
export function qqSettings(value?: Partial<QqSettings>): QqSettings {
  return {...DEFAULT_QQ_SETTINGS,...value,groupIds:[...(value?.groupIds??[])],mainSessionPeers:[...(value?.mainSessionPeers??[])],autonomousGroupIds:[...(value?.autonomousGroupIds??[])]}
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
  return {mainSessionPeers:[...new Set(peers)],autonomousGroupIds:[...new Set(autonomous)],stickerSource:v.stickerSource??'channel',privateReplies:v.privateReplies,groupReplies:v.groupReplies,mentionSender:v.mentionSender,facesEnabled:v.facesEnabled,imagesEnabled:v.imagesEnabled,groupTrigger:v.groupTrigger,groupIds:[...new Set(v.groupIds)]} as QqSettings
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
