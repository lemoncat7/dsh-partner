interface MemoryRoute { memoryScopeId?: string; companionId: string; sessionId: string; channelId: string; userId: string; kind?: string }

/** An editor opened on a channel transcript still uses that transcript's audience. */
export function groupConversation(route: MemoryRoute, routes: readonly MemoryRoute[]): boolean {
  if (route.userId.startsWith('group:')) return true
  if (route.kind !== 'local') return false
  const linked = routes.filter(item => item.sessionId === route.sessionId && item.companionId === route.companionId)
  return linked.length > 0 && linked.every(item => item.kind === 'channel' && item.userId.startsWith('group:'))
}

/** Explicit companion memory sharing is independent of transcript routing. */
export function conversationMemoryScope(route: MemoryRoute, routes: readonly MemoryRoute[]): string {
  if (route.memoryScopeId) return route.memoryScopeId
  const primary = routes.find(item => item.companionId === route.companionId
    && item.sessionId === route.sessionId && item.kind === 'local')
  return primary ? `${primary.channelId}:${primary.userId}` : `${route.channelId}:${route.userId}`
}
