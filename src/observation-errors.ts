/** Small allowlisted diagnostic surface. Never serialize response/request bodies. */
export function redactObservationError(text: string, secrets: Iterable<string> = []): string {
  let safe = text
  for (const secret of secrets) if (secret.length >= 4) safe = safe.split(secret).join('[已隐藏]')
  safe = safe
    .replace(/https?:\/\/[^\s<>"']+/giu, '[URL已隐藏]')
    .replace(/(?:authorization|cookie|set-cookie|password|passwd|密码|api[_-]?key|access[_-]?token|token)\s*["']?\s*[:：=]\s*[^\r\n]+/giu, '[凭据已隐藏]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(/(?:api\s+key|credential)(?:\s+(?:provided|is))?\s*[:=]\s*\S+/giu, 'credential: [已隐藏]')
    .replace(/\b(?:sk-|tk-)[A-Za-z0-9_-]+/gu, '[密钥已隐藏]')
    .replace(/登录账号\s+\S+/gu, '登录账号 [已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
  return safe.slice(0, 500)
}

export function observationFailure(error: unknown, context: {
  phase: string; round: number; elapsedMs: number; toolAborted?: boolean
}, secrets: Iterable<string> = []): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const failure = value.failure && typeof value.failure === 'object' ? value.failure as Record<string, unknown> : value
  const code = typeof failure.code === 'string' && /^[A-Z0-9_:-]{1,64}$/u.test(failure.code) ? failure.code : undefined
  const status = typeof failure.status === 'number' && failure.status >= 100 && failure.status <= 599 ? failure.status : undefined
  const name = typeof value.name === 'string' ? value.name : ''
  const reason = context.toolAborted ? '单次工具达到 60 秒执行时限'
    : name === 'AbortError' ? '调用被取消'
    : name === 'TimeoutError' ? '调用超时'
    : typeof failure.message === 'string' ? redactObservationError(failure.message, secrets) : '未提供可用的底层错误摘要'
  return `${context.phase}失败 · 第 ${context.round} 轮 · 已用 ${Math.round(context.elapsedMs / 1000)} 秒${code ? ` · ${code}` : ''}${status ? ` · HTTP ${status}` : ''}：${reason}`
}

export class ObservationModelError extends Error {
  constructor(readonly failure: {message: string; code: string; status?: number}) {
    super('关注模型调用失败')
  }
}
