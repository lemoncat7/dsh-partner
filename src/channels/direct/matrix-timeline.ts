/** Recover a truncated /sync interval using forward room pagination. Tokens are
 * opaque: never compare timestamps or reset the persisted sync watermark. */
export async function matrixTimeline(
  roomId: string, timeline: any, since: string | undefined, until: string,
  request: (path: string) => Promise<any>, signal: AbortSignal,
): Promise<any[]> {
  if (!since) return [] // First connection must not execute old conversations.
  const live = timeline?.events ?? []
  if (!Array.isArray(live)) throw new Error('Matrix 时间线格式无效')
  if (!timeline?.limited) return live
  const events = new Map<string, any>()
  let bytes = 0
  const append = (items: any[]): void => {
    for (const event of items) {
      if (!event || typeof event.event_id !== 'string') throw new Error('Matrix 补拉消息缺少事件 ID，保留原游标')
      if (events.has(event.event_id)) continue
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (events.size >= 10_000 || bytes > 16 * 1024 * 1024) throw new Error('Matrix 消息积压超过补拉安全上限，保留原游标，请检查积压')
      events.set(event.event_id, event)
    }
  }
  let from = since
  const visited = new Set<string>([from])
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted()
    const query = new URLSearchParams({from, to: until, dir: 'f', limit: '100'})
    const result = await request('/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/messages?' + query)
    signal.throwIfAborted()
    if (!result || !Array.isArray(result.chunk)) throw new Error('Matrix 补拉响应无效，保留原游标')
    append(result.chunk)
    // End is absent at exhaustion. Empty filtered pages may still advance, so
    // do not use chunk.length < limit (or zero) as evidence of completion.
    if (result.end === undefined || result.end === until) {
      append(live)
      return [...events.values()]
    }
    if (typeof result.end !== 'string' || !result.end || visited.has(result.end)) {
      throw new Error('Matrix 补拉游标未推进，保留原游标')
    }
    visited.add(result.end)
    from = result.end
  }
  throw new Error('Matrix 补拉超过分页安全上限，保留原游标')
}
