import { randomUUID } from 'node:crypto'

export class OneBotError extends Error {
  constructor(message: string, readonly retryable = true) { super(message) }
}

/** One universal forward WS carries events and echo-correlated API responses.
 * Mutating API requests are never replayed after disconnect or timeout. */
export class OneBotConnection {
  private socket: WebSocket | undefined
  private opening: Promise<void> | undefined
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  private events: unknown[] = []
  private wake: (() => void) | undefined
  private fault: OneBotError | undefined
  private stopped = false
  constructor(private readonly address: string, private readonly token: string) {}

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.stopped) throw new OneBotError('QQ 渠道已停止', false)
    if (this.fault && !this.fault.retryable) throw this.fault
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (!this.opening) {
      this.opening = this.open().finally(() => { this.opening = undefined })
    }
    await this.withAbort(this.opening, signal)
  }

  private open(): Promise<void> {
    const url = new URL(this.address)
    if (this.token) url.searchParams.set('access_token', this.token)
    const socket = new WebSocket(url)
    this.socket = socket
    this.fault = undefined
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OneBotError('QQ WebSocket 连接超时，请检查地址、端口和 WS Token'))
        socket.close()
      }, 15000)
      const fail = () => {
        clearTimeout(timer)
        const error = this.fault ?? new OneBotError('QQ WebSocket 已断开，请检查 SnowLuma 登录状态和 WS Token')
        reject(error)
        if (this.socket !== socket) return
        this.socket = undefined
        this.fault = error
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.wake?.()
      }
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', fail)
      socket.addEventListener('close', fail)
      socket.addEventListener('message', event => {
        if (this.socket !== socket || this.stopped) return
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8 * 1024 * 1024) throw Error()
          const data = JSON.parse(event.data)
          if (!data || typeof data !== 'object') throw Error()
          if (typeof data.echo === 'string') {
            const pending = this.pending.get(data.echo)
            if (!pending) return
            this.pending.delete(data.echo)
            if (data.status === 'ok' && data.retcode === 0) pending.resolve(data.data)
            else pending.reject(new OneBotError(`QQ 接口执行失败（retcode ${Number.isFinite(data.retcode) ? data.retcode : '未知'}）`, false))
          } else if (data.post_type === 'message' && data.message_type === 'private') {
            if (this.events.length >= 500) {
              this.fault = new OneBotError('QQ 消息积压超过 500 条，请检查处理状态后重新启用渠道', false)
              socket.close(); this.wake?.(); return
            }
            this.events.push(data)
            this.wake?.()
          }
        } catch {
          this.fault = new OneBotError('QQ 返回了无效或过大的协议消息', false)
          socket.close(); this.wake?.()
        }
      })
    })
  }

  async call(action: string, params: Record<string, unknown>, signal = AbortSignal.timeout(30000)): Promise<any> {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    await this.connect(lifetime)
    lifetime.throwIfAborted()
    const echo = randomUUID()
    let abort: () => void = () => {}
    try {
      return await new Promise((resolve, reject) => {
        abort = () => { this.pending.delete(echo); reject(new OneBotError('QQ 请求已取消或超时；发送结果未知，不会自动重发')) }
        lifetime.addEventListener('abort', abort, { once: true })
        this.pending.set(echo, { resolve, reject })
        try { this.socket!.send(JSON.stringify({ action, params, echo })) }
        catch { this.pending.delete(echo); reject(new OneBotError('QQ 连接不可用，操作未确认')) }
      })
    } finally { lifetime.removeEventListener('abort', abort); this.pending.delete(echo) }
  }

  async read(signal: AbortSignal, waitMs: number): Promise<unknown[]> {
    await this.connect(signal)
    if (!this.events.length && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: () => void = () => {}
      try {
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve
          timer = setTimeout(resolve, waitMs)
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      } finally { clearTimeout(timer); this.wake = undefined; signal.removeEventListener('abort', abort) }
    }
    signal.throwIfAborted()
    if (this.fault) throw this.fault
    return this.events.splice(0)
  }

  close(): void {
    this.stopped = true
    for (const pending of this.pending.values()) pending.reject(new OneBotError('QQ 渠道已停止', false))
    this.pending.clear()
    this.socket?.close(); this.socket = undefined
    this.wake?.(); this.events = []
  }

  private async withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: () => void = () => {}
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })]) } finally { signal.removeEventListener('abort', abort) }
  }
}
