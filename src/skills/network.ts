import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'

const MAX_REDIRECTS = 5

export interface RemoteTextRequest {
  url: string
  maxBytes: number
  timeoutMs: number
  method?: string
  headers?: HeadersInit
  body?: string
  proxyUrl?: string
}

/** A bounded HTTP client used by both market discovery and package installs. */
export async function requestRemoteText(input: RemoteTextRequest): Promise<string> {
  return new TextDecoder().decode(await requestRemoteBytes(input))
}

export function requestRemoteBytes(input: RemoteTextRequest): Promise<Uint8Array> {
  return input.proxyUrl
    ? requestThroughHttpProxy(input, 0)
    : requestDirect(input)
}

export function normalizeProxyUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('proxyUrl must be a string')
  const proxy = new URL(value.trim())
  if (proxy.protocol !== 'http:') throw new Error('Skill 市场代理目前仅支持 http:// 地址')
  if (proxy.username || proxy.password) throw new Error('Skill 市场代理地址不能包含账号或密码')
  if (proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('Skill 市场代理地址不能包含路径、查询参数或片段')
  return proxy.toString()
}

async function requestDirect(input: RemoteTextRequest): Promise<Uint8Array> {
  const response = await fetch(input.url, {
    ...(input.method ? { method: input.method } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    signal: AbortSignal.timeout(input.timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${new URL(input.url).host}`)
  const advertised = Number(response.headers.get('content-length') ?? 0)
  if (advertised > input.maxBytes) throw new Error('Remote content exceeds the size limit')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > input.maxBytes) throw new Error('Remote content exceeds the size limit')
  return bytes
}

async function requestThroughHttpProxy(input: RemoteTextRequest, redirects: number): Promise<Uint8Array> {
  if (redirects > MAX_REDIRECTS) throw new Error('Skill market request exceeded the redirect limit')
  const target = new URL(input.url)
  const proxy = new URL(normalizeProxyUrl(input.proxyUrl)!)
  const response = target.protocol === 'https:'
    ? await tunnelHttps(target, proxy, input)
    : await proxyHttp(target, proxy, input)
  const location = response.headers.location
  if (location && [301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.resume()
    const switchToGet = response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && input.method === 'POST')
    if (switchToGet) {
      const { body: _body, method: _method, ...rest } = input
      return requestThroughHttpProxy({ ...rest, method: 'GET', url: new URL(location, target).toString() }, redirects + 1)
    }
    return requestThroughHttpProxy({ ...input, url: new URL(location, target).toString() }, redirects + 1)
  }
  return readBounded(response, input.maxBytes, target.host)
}

function proxyHttp(target: URL, proxy: URL, input: RemoteTextRequest): Promise<IncomingMessage> {
  const headers = requestHeaders(input.headers, target.host, input.body)
  return issue(httpRequest, {
    hostname: proxy.hostname,
    port: proxy.port || 80,
    method: input.method ?? 'GET',
    path: target.toString(),
    headers,
  }, input.body, input.timeoutMs)
}

function tunnelHttps(target: URL, proxy: URL, input: RemoteTextRequest): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const targetPort = Number(target.port || 443)
    const connectRequest = httpRequest({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: { host: `${target.hostname}:${targetPort}` },
    })
    const fail = (error: unknown): void => reject(networkError(error))
    connectRequest.setTimeout(input.timeoutMs, () => connectRequest.destroy(new Error('Skill market proxy connection timed out')))
    connectRequest.once('error', fail)
    connectRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`Skill market proxy CONNECT returned HTTP ${response.statusCode ?? 0}`))
        return
      }
      if (head.byteLength > 0) socket.unshift(head)
      const secureSocket = tlsConnect({ socket, servername: target.hostname })
      secureSocket.setTimeout(input.timeoutMs, () => secureSocket.destroy(new Error('Skill market TLS connection timed out')))
      secureSocket.once('error', fail)
      secureSocket.once('secureConnect', () => {
        const headers = requestHeaders(input.headers, target.host, input.body)
        void issue(httpsRequest, {
          hostname: target.hostname,
          port: targetPort,
          method: input.method ?? 'GET',
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
          createConnection: () => secureSocket,
        }, input.body, input.timeoutMs).then(resolve, reject)
      })
    })
    connectRequest.end()
  })
}

function issue(
  request: typeof httpRequest,
  options: RequestOptions,
  body: string | undefined,
  timeoutMs: number,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request(options, resolve)
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('Skill market request timed out')))
    outgoing.once('error', error => reject(networkError(error)))
    if (body) outgoing.write(body)
    outgoing.end()
  })
}

function requestHeaders(value: HeadersInit | undefined, host: string, body: string | undefined): Record<string, string> {
  const headers = Object.fromEntries(new Headers(value).entries())
  headers.host = host
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  return headers
}

function readBounded(response: IncomingMessage, limit: number, host: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.resume()
      reject(new Error(`HTTP ${response.statusCode ?? 0} while fetching ${host}`))
      return
    }
    const advertised = Number(response.headers['content-length'] ?? 0)
    if (advertised > limit) {
      response.destroy()
      reject(new Error('Remote content exceeds the size limit'))
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    response.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > limit) {
        response.destroy(new Error('Remote content exceeds the size limit'))
        return
      }
      chunks.push(chunk)
    })
    response.once('end', () => resolve(Buffer.concat(chunks)))
    response.once('error', error => reject(networkError(error)))
  })
}

function networkError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
