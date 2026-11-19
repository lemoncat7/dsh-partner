import type {ChannelSessionView} from '../../client-api.js'

/** Route aliases are delivery identities, not independent conversation logs. */
export function groupMemorySessions(sessions: ChannelSessionView[], channels: Array<{id:string;platform?:string}>) {
  const groups = new Map<string,ChannelSessionView[]>()
  for (const route of sessions) groups.set(route.sessionId,[...(groups.get(route.sessionId)??[]),route])
  return [...groups.values()].map(routes => {
    const session = [...routes].sort((a,b)=>Number(b.kind==='local')-Number(a.kind==='local')||b.lastMessageAt-a.lastMessageAt)[0]!
    const platform = channels.find(c=>c.id===session.channelId)?.platform ?? '渠道'
    const group = session.userId.match(/^group:([^:]+)/)?.[1]
    const label = session.kind==='local' ? '本地与私聊' : group ? `${platform.toUpperCase()} 群 · ${group}` : `${platform.toUpperCase()} 联系人 · ${session.userId.slice(-6)}`
    return {session,label,routeCount:routes.length}
  })
}
