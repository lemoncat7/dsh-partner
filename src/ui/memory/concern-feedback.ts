type Kind = 'error' | 'warning' | 'success'
/** One feedback region; never render the same run as both success and failure. */
export function concernFeedback(input: {error?: string | undefined; notice?: string | undefined; noticeKind: Kind; checking: boolean; lastError?: string | undefined; lastOutcome?: string | undefined}): {text: string; kind: Kind} | undefined {
  if (input.error) return {text: input.error, kind:'error'}
  if (input.notice && input.noticeKind !== 'success') return {text:input.notice,kind:input.noticeKind}
  if (!input.checking && input.lastError) return {text:input.lastError,kind:input.lastOutcome === 'partial' ? 'warning' : 'error'}
  if (input.notice) return {text:input.notice,kind:input.noticeKind}
  return undefined
}
