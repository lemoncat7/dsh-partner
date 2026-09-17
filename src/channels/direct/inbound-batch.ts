import { setTimeout as delay } from 'node:timers/promises'
import type { DirectBatch, DirectMessage } from './transport.js'

const GROUP_WINDOW_MS = 2000
const MAX_GROUP_EVENTS = 16

/** Matrix clients may send caption and file as separate adjacent events. Only
 * coalesce a bounded burst containing media, never plain-text conversations. */
export function groupDirectMessages(messages: readonly DirectMessage[], defaultTarget = ''): DirectMessage[][] {
  const groups: DirectMessage[][] = []
  let burst: DirectMessage[] = []
  const flush = () => {
    if (burst.some(message => message.media?.length)) groups.push(burst)
    else groups.push(...burst.map(message => [message]))
    burst = []
  }
  for (const message of messages) {
    const first = burst[0], previous = burst.at(-1)
    if (first && previous && (burst.length >= MAX_GROUP_EVENTS || message.sender !== first.sender
      || (message.targetId ?? defaultTarget) !== (first.targetId ?? defaultTarget)
      || !Number.isFinite(message.timestamp) || !Number.isFinite(first.timestamp)
      || message.timestamp! < previous.timestamp! || message.timestamp! - first.timestamp! > GROUP_WINDOW_MS)) flush()
    burst.push(message)
  }
  flush()
  return groups
}

/** One bounded lookahead, not a background queue. The cursor is committed only
 * after every collected event is handed off, so restart never discards a buffer. */
export async function collectDirectBatch(first: DirectBatch, poll: (cursor: string, signal: AbortSignal) => Promise<DirectBatch>, signal: AbortSignal, waitMs = 1000): Promise<DirectBatch> {
  if (!first.messages.length) return first
  await delay(waitMs, undefined, { signal })
  const next = await poll(first.cursor, signal)
  const seen = new Set<string>()
  const messages = [...first.messages, ...next.messages].filter(message => {
    const key = JSON.stringify([message.targetId, message.sender, message.id])
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  return { cursor: next.cursor, messages, ...(next.warning ?? first.warning ? { warning: next.warning ?? first.warning! } : {}) }
}
