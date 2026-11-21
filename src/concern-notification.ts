import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isPluginSource } from './message-source.js'
import type { PartnerConcern } from './concern-domain.js'

export const CONCERN_CREATED_NOTICE = '伙伴自动新增关注'
export const CONCERN_EXECUTION_NOTICE = '关注变化 · 直接执行'

export function isConcernExecutionNotice(event: SessionEvent): boolean {
  return event.type === 'user/message' && isPluginSource(event.data.source, '@lemoncat7/dsh-partner')
    && event.data.source.form === 'notice' && event.data.source.summary === CONCERN_EXECUTION_NOTICE
}

export function renderConcernCreatedNotice(concerns: readonly PartnerConcern[]): string {
  const lines = concerns.flatMap((concern, index) => [
    `${index + 1}. ${concern.subject}`,
    ...(concern.reason ? [`   ${concern.reason}`] : []),
  ])
  return [
    `伙伴刚刚自动新增了 ${concerns.length} 条关注：`,
    '',
    ...lines,
    '',
    '可以在「伙伴 > 在意的事」中查看；不需要时选择「别管这个」。',
  ].join('\n')
}

export function concernCreatedNoticeFromEvent(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source
  if (!isPluginSource(source, '@lemoncat7/dsh-partner')
    || source.form !== 'notice' || source.summary !== CONCERN_CREATED_NOTICE) return undefined
  const value = event.data.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text.trim()).filter(Boolean).join('\n')
  return value || undefined
}
