interface MemoryRoute { memoryScopeId?: string; companionId: string; sessionId: string; channelId: string; userId: string; kind?: string }

/** Explicit companion memory sharing is independent of transcript routing. */
export function conversationMemoryScope(route: MemoryRoute, routes: readonly MemoryRoute[]): string {
  if (route.memoryScopeId) return route.memoryScopeId
  const primary = routes.find(item => item.companionId === route.companionId
    && item.sessionId === route.sessionId && item.kind === 'local')
  return primary ? `${primary.channelId}:${primary.userId}` : `${route.channelId}:${route.userId}`
}
