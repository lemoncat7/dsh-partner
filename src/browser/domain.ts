export interface BrowserConfig {
  enabled: boolean
  autonomous: boolean
  endpoint: string
  externalUrl?: string
  updatedAt: number
}

export function browserEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw Error('请填写 CDP 地址')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw Error('CDP 地址格式无效') }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('CDP 地址须为 HTTP 或 WebSocket 地址，不接受内嵌密码或查询参数')
  if (url.protocol.startsWith('http') ? url.pathname !== '/' : !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname)) throw Error('HTTP 地址只填主机和端口；WebSocket 地址须指向 /devtools/browser/…')
  return url.toString()
}

/** Human-facing remote browser address; never used as the CDP endpoint. */
export function browserExternalUrl(value: unknown): string | undefined {
  if(value===undefined||value==='')return undefined
  if(typeof value!=='string'||value.length>2048)throw Error('外部访问地址无效')
  if(!value.trim())return undefined
  let url:URL
  try{url=new URL(value.trim())}catch{throw Error('外部访问地址格式无效')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('外部访问地址须为 HTTP/HTTPS 网页，不接受内嵌账号密码或查询参数')
  return url.toString()
}

export function validateBrowserConfig(value: BrowserConfig): void {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.autonomous !== 'boolean' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 1 || browserEndpoint(value.endpoint) !== value.endpoint) throw Error('浏览器配置无效')
  if(value.externalUrl!==undefined&&browserExternalUrl(value.externalUrl)!==value.externalUrl)throw Error('外部访问地址无效')
}
