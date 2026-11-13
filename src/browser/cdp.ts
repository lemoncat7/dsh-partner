import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { browserEndpoint } from './domain.js'

// ws implements the browser EventTarget API and adds deterministic termination.
// Some older Chrome builds never finish a WebSocket close handshake.
type Socket = WebSocket & {terminate(): void}
const WebSocketClient = createRequire(import.meta.url)('ws') as {
  new(url:string, options:{handshakeTimeout:number;maxPayload:number;perMessageDeflate:boolean}): Socket
}

/** Chrome accepts localhost/IP Host headers but rejects Docker service names. */
async function discover(endpoint: string, signal: AbortSignal): Promise<string> {
  const base = new URL(browserEndpoint(endpoint))
  if (base.protocol.startsWith('ws')) return base.toString()
  const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = (base.protocol === 'https:' ? httpsRequest : httpRequest)(new URL('/json/version', base), {signal, headers: {Host: 'localhost', Accept: 'application/json'}}, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error(`CDP 发现失败（HTTP ${res.statusCode}），请检查调试端口`)); return }
      let size = 0; const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) res.destroy(Error('CDP 发现响应过大')); else chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Error('该地址没有返回 Chrome CDP 信息，请勿填写远程桌面端口')) } })
    })
    req.on('error', () => reject(Error(signal.aborted ? '浏览器连接已取消或超时' : '无法连接 CDP，请检查地址和容器网络')))
    req.end()
  })
  const advertised = new URL(String(data.webSocketDebuggerUrl))
  if (!['ws:', 'wss:'].includes(advertised.protocol) || !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(advertised.pathname)) throw Error('CDP 未提供有效的浏览器连接地址')
  // Discovery often advertises localhost, a container IP or a stale hostname.
  // Keep the explicitly configured server; never follow an advertised host.
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  base.pathname = advertised.pathname
  return base.toString()
}

export class CdpConnection {
  private sequence = 0
  private pending = new Map<number, {resolve(value: any): void; reject(error: Error): void}>()
  private closed = false
  private constructor(private socket: Socket, private signal: AbortSignal, private guard: () => void) {}
  static async connect(endpoint: string, signal: AbortSignal, guard: () => void = () => {}): Promise<CdpConnection> {
    guard(); signal.throwIfAborted()
    const url = await discover(endpoint, signal)
    guard(); signal.throwIfAborted()
    const socket = new WebSocketClient(url, {handshakeTimeout:10000,maxPayload:12*1024*1024,perMessageDeflate:false})
    const client = new CdpConnection(socket, signal, guard)
    socket.addEventListener('message', client.message)
    socket.addEventListener('close', client.lost)
    socket.addEventListener('error', client.lost)
    signal.addEventListener('abort', client.abort, {once: true})
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); signal.removeEventListener('abort', cancelled) }
        const opened = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(Error('CDP WebSocket 连接失败')) }
        const cancelled = () => { cleanup(); reject(Error('浏览器连接已取消或超时')) }
        socket.addEventListener('open', opened, {once:true}); socket.addEventListener('error', failed, {once:true}); socket.addEventListener('close', failed, {once:true}); signal.addEventListener('abort', cancelled, {once:true})
        if (signal.aborted) cancelled()
      })
      guard(); signal.throwIfAborted(); return client
    } catch (error) { client.close(); throw error }
  }
  private message = (event: MessageEvent) => {
    if (typeof event.data !== 'string' || event.data.length > 12 * 1024 * 1024) { this.close(); return }
    let message: any
    try { message = JSON.parse(event.data) } catch { this.close(); return }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(Error(`CDP 操作失败：${String(message.error.message).slice(0,300)}`))
    else pending.resolve(message.result ?? {})
  }
  private lost = () => this.close()
  private abort = () => this.close()
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    this.guard(); this.signal.throwIfAborted()
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw Error('浏览器连接已断开；写操作结果未知时请先检查页面，不要自动重复提交')
    const id = ++this.sequence
    const result = await new Promise<any>((resolve, reject) => {
      this.pending.set(id, {resolve, reject})
      try { this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})) } catch { this.pending.delete(id); reject(Error('CDP 发送失败，操作结果未知，请先检查页面')) }
    })
    this.guard(); this.signal.throwIfAborted(); return result
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.signal.removeEventListener('abort', this.abort)
    this.socket.removeEventListener('message', this.message)
    this.socket.removeEventListener('close', this.lost)
    // Keep the error listener until the socket closes; connecting sockets can emit error.
    for (const p of this.pending.values()) p.reject(Error('浏览器连接已取消、断开或超时；写操作结果未知，请先检查页面，不要自动重复提交'))
    this.pending.clear()
    this.socket.terminate()
  }
}
