import type { SessionEvent } from '@deepseek-ai/dsh-session'

const INTERNAL_TASK_NOTICES = new Set([
  '看板任务待验收', '看板任务已完成', '看板任务受阻', '伙伴执行看板任务', '伙伴核验看板任务',
])

export function isInternalTaskNotice(event: SessionEvent): boolean {
  return event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === '@lemoncat7/dsh-partner' && event.data.source.form === 'notice'
    && INTERNAL_TASK_NOTICES.has(event.data.source.summary ?? '')
}

/** Goal completion may share a turn with review; it must not bypass silence. */
export function isAutonomousDeliveryTurn(events: readonly SessionEvent[], history: readonly SessionEvent[] = events): boolean {
  if (events.some(isInternalTaskNotice)) return false
  // Goal completion can be delivered in a separate continuation turn. Carry
  // the most recent task/user origin across goal notices, not across new input.
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!
    if (isInternalTaskNotice(event)) return false
    if (event.type === 'user/message' && event.data.source.kind === 'user') break
  }
  return events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'tool-goal' && event.data.source.form === 'notice'
    && event.data.source.summary?.startsWith('complete:'))
}

export interface ChannelReplyParts {
  text: string
  /** Assistant-authored file references survive filtering of progress prose. */
  referenceTexts: string[]
}

/** Select the last non-tool answer per eligible turn, never tool preambles. */
export function channelReplyPartsAfter(events: readonly SessionEvent[], fromSeq: number, autonomous = false): ChannelReplyParts {
  let direct = autonomous
  let answer = ''
  let references: string[] = []
  const messages: string[] = [], referenceTexts: string[] = []
  const flush = (): void => {
    if (direct) {
      if (answer) messages.push(answer)
      referenceTexts.push(...references)
    }
    answer = ''; references = []
  }
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'turn/start') { flush(); direct = autonomous }
    else if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'completed') { answer = ''; references = [] }
      flush(); direct = false
    }
    else if (event.type === 'user/message' && event.data.source.kind === 'user') direct = true
    else if (isInternalTaskNotice(event)) { answer = ''; references = []; direct = false }
    else if (direct && event.type === 'tool/result') answer = ''
    else if (direct && event.type === 'assistant/message' && !event.data.interrupted) {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.trim()) references.push(text.trim())
      if (event.data.message.content.some(block => block.type === 'tool-call')) answer = ''
      else if (text.trim()) answer = text.trim()
    }
  }
  flush()
  return { text: messages.join('\n\n'), referenceTexts }
}

/** whenIdle may encompass follow-up turns: don't append internal reviews to a user reply. */
export function channelReplyTextAfter(events: readonly SessionEvent[], fromSeq: number): string {
  return channelReplyPartsAfter(events, fromSeq).text
}
