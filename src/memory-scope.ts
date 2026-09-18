interface MemoryRoute { companionId: string; sessionId: string; channelId: string; userId: string; kind?: string }

/** Only routes already attached to the same conversation share memory. */
export function conversationMemoryScope(route: MemoryRoute, routes: readonly MemoryRoute[]): string {
  const primary = routes.find(item => item.companionId === route.companionId
    && item.sessionId === route.sessionId && item.kind === 'local')
  return primary ? `${primary.channelId}:${primary.userId}` : `${route.channelId}:${route.userId}`
}
