export const NOTIFICATION_TEXT_TIMEOUT_MS = 30_000
export const NOTIFICATION_ATTACHMENT_TIMEOUT_MS = 300_000

/** Allocate the budget only when an unacknowledged part actually starts. */
export async function sendNotificationPart(
  attachment: boolean,
  send: (signal: AbortSignal) => Promise<unknown>,
  stopped: AbortSignal,
  timeout: (ms: number) => AbortSignal = AbortSignal.timeout,
): Promise<void> {
  const signal = AbortSignal.any([stopped, timeout(attachment ? NOTIFICATION_ATTACHMENT_TIMEOUT_MS : NOTIFICATION_TEXT_TIMEOUT_MS)])
  signal.throwIfAborted()
  await send(signal)
}

/** Deliberately whitelist diagnostics: upstream messages may contain credentials or signed URLs. */
export function notificationFailureReason(error: unknown): string {
  const value = error instanceof Error ? `${error.name} ${error.message}` : ''
  if (/timeout|timed out|超时/i.test(value)) return '发送超时'
  if (/abort|停止/i.test(value)) return '发送已中断'
  const status = value.match(/(?:HTTP|status)\s*[:=]?\s*([45]\d{2})\b/i)?.[1]
  if (status) return `渠道返回 HTTP ${status}`
  if (/ENOENT|不存在/i.test(value)) return '文件或渠道不存在'
  if (/批准|授权|停用|不属于/i.test(value)) return '渠道不可用或接收权限已变更'
  if (/fetch|network|ECONN|offline|网络/i.test(value)) return '网络连接失败'
  return '渠道发送失败，请检查渠道连接与附件限制'
}
