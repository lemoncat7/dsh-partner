import type {SessionEvent} from '@deepseek-ai/dsh-session'

/** A later unrelated answer must never acknowledge this delivery. */
export function hasConcernReply(events: readonly SessionEvent[], messageId: string): boolean {
  let found = false, answer = false
  for (const event of events) {
    if (event.type === 'user/message') {
      // Newer Harness versions persist context snapshots as user/message.
      const kind: string | undefined = event.data.source?.kind
      if (kind && ['runtime-context','system-prompt','model-selection','tool-registry','ptc-mode'].includes(kind)) continue
      if (found) return false
      found = event.data.id === messageId
      continue
    }
    if (!found) continue
    if (event.type === 'tool/call' || event.type === 'tool/result') answer = false
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      answer = event.data.message.content.some(b => b.type === 'text' && b.text.trim().length > 0)
        && !event.data.message.content.some(b => b.type === 'tool-call')
    }
    if (event.type === 'turn/end') return answer && event.data.reason.kind === 'completed'
  }
  return false
}
