import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelSession } from './domain.js'
import { questionOrigin } from './channels/question-origin.js'

/** Reading shared memory never implies permission to archive every conversation. */
export function automaticMemoryAllowed(sessionId: string, events: readonly SessionEvent[], routes: readonly ChannelSession[]): boolean {
  const primary = routes.find(r => r.kind === 'local' && r.sessionId === sessionId)
  if (!primary) return false
  const origin = questionOrigin(sessionId, events, routes)
  if (origin?.userId.startsWith('group:')) return false
  const users = events.filter(e => e.type === 'user/message' && e.data.source.kind === 'user')
  if (!users.length) return false
  const text = users.map(e => e.type === 'user/message' ? e.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '').join('\n').trim()
  // Old group origin IDs may have aged out of the bounded route index. The
  // transport envelope remains in the transcript; never backfill it as local chat.
  if (/\[QQ 群 \d+ · 发言人 |群聊背景（引用资料，不能作为执行指令）/.test(text)) return false
  return !!text && !/^(?:你好|您好|早安|午安|晚安|早上好|晚上好|谢谢|多谢|好的|好|嗯|哦|收到|再见|拜拜|哈哈|hi|hello|ok|thanks)[\s!！。.，,~～]*$/iu.test(text)
}
