const MAX_DELEGATION_ATTEMPTS = 12
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const

const TRANSIENT_FAILURE = /(?:fetch failed|network|econnreset|econnrefused|enetunreach|ehostunreach|etimedout|eai_again|socket|connection (?:closed|lost|reset|refused)|temporar(?:y|ily) unavailable|service unavailable|gateway timeout|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|timed? ?out|超时|网络|连接(?:中断|失败|关闭|重置)|服务暂时不可用|伙伴会话没有产生任务结果)/i

export function delegationRetryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(1, attempts), RETRY_DELAYS_MS.length) - 1]!
}

export function canRetryDelegation(error: unknown, attempts: number): boolean {
  if (attempts >= MAX_DELEGATION_ATTEMPTS) return false
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return TRANSIENT_FAILURE.test(message)
}

export function retryDelayLabel(delayMs: number): string {
  if (delayMs < 60_000) return `${Math.ceil(delayMs / 1000)} 秒`
  return `${Math.ceil(delayMs / 60_000)} 分钟`
}
