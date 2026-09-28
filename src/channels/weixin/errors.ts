/** Structured failures: never classify authentication by localized error text. */
export class WeixinHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) {
    super(`微信接口 HTTP ${status}`)
  }
}

export class WeixinResponseError extends Error {
  constructor(readonly ret: number, readonly code: number) {
    super(`微信 getupdates 返回 ret=${ret}, errcode=${code}`)
  }
}

export function weixinAuthenticationFailure(error: unknown): boolean {
  return error instanceof WeixinHttpError && [401, 403].includes(error.status)
    || error instanceof WeixinResponseError && (error.code === -14 || error.ret === -14)
}

export function weixinTransientFailure(error: unknown): boolean {
  return error instanceof WeixinHttpError
    ? [408, 429].includes(error.status) || error.status >= 500
    : error instanceof Error && (error.name === 'TimeoutError' || error instanceof TypeError && error.message === 'fetch failed')
}
