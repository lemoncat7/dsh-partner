import {createHash} from 'node:crypto'
import type {PartnerConcern} from './concern-domain.js'

export interface ObservationProgress {signature:string; savedAt:number; steps:Array<{tool:string; error:boolean; text:string}>; workflow?: import('./observation-workflow.js').ObservationWorkflow}
export function observationSignature(item:PartnerConcern):string {
  return createHash('sha256').update(JSON.stringify([item.subject,item.reason,item.executionInstructions,item.resources,item.recordTarget])).digest('hex')
}
export function resumeObservation(item:PartnerConcern, now=Date.now()):ObservationProgress|undefined {
  const p=item.observationProgress
  return p && p.signature===observationSignature(item) && now-p.savedAt>=0 && now-p.savedAt<24*3600000 ? p : undefined
}
/** Only explicit credential-to-host language is treated as a binding, never all URLs in a document. */
export function authenticatedObservationHosts(text:string):Set<string> {
  const hosts=new Set<string>()
  for(const line of text.split('\n')) {
    if(!/token|令牌|凭据|authorization|api.?key/i.test(line))continue
    for(const m of line.matchAll(/(?:用于|仅向|仅发往|only\s+(?:for|to))\s*(?:https:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?=[\s/:，。；;]|$)/gi)) hosts.add(m[1]!.toLowerCase())
  }
  return hosts
}
export function observationAuthDenial(name:string,args:unknown,hosts:Set<string>):string|undefined {
  if(!['web_fetch','web_source'].includes(name))return
  const raw=JSON.stringify(args)
  for(const match of raw.matchAll(/https?:\/\/[^\s"<>\\]+/gi)) {
    try {const url=new URL(match[0]);if(hosts.has(url.hostname.toLowerCase()))return '该 API 域名在关注说明中明确要求认证；此网页工具不能保证携带所需凭据。请使用原会话已授权的命令工具按说明发起认证请求，先检查凭据是否加载，禁止打印凭据、跨域转发或改发匿名请求。'}catch{}
  }
}
export function redactProgress(text:string,secrets:Iterable<string>):string {
  // Tool results are often JSON. Redact individual values, not a serialized
  // line whose escaped newlines would make one credential erase the rest.
  const credentials = [...secrets]
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactProgressText(value, credentials)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, /^(?:authorization|cookie|set-cookie|password|passwd|密码|令牌|api[_-]?key|access[_-]?token|token)$/i.test(key) ? '[凭据字段已隐藏]' : walk(child)]))
    return value
  }
  try {return JSON.stringify(walk(JSON.parse(text)))} catch {return redactProgressText(text, credentials)}
}
function redactProgressText(text:string,secrets:Iterable<string>):string {
  let safe=text
  for(const secret of secrets)if(secret.length>=4)safe=safe.split(secret).join('[已隐藏]')
  return safe.replace(/\b(?:gh[pousr]_|github_pat_|sk-|npm_)[\w-]+/g,'[已隐藏]')
    .replace(/(?:authorization|cookie|set-cookie|password|passwd|密码|令牌|api[_-]?key|access[_-]?token|token)\s*["']?\s*[:：=]\s*[^\r\n]+/gi,'[凭据字段已隐藏]')
    .replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]')
    .replace(/https?:\/\/[^\s"<>`\\，。；、！？（）【】]+/gi,value=>{const trailing=value.match(/[).,;!?]+$/)?.[0]??'';try{const u=new URL(value.slice(0,value.length-trailing.length));u.username='';u.password='';u.search='';return u.toString()+trailing}catch{return '[URL已隐藏]'+trailing}})
}
export function observationHttpHint(text:string):string {
  if(!/\b(?:401|403|429)\b/.test(text))return ''
  return '\n[认证/限流诊断：401通常涉及认证；403可能是未带认证、权限不足或限流，不能仅凭状态码定性；429通常表示限流。核对实际请求是否加载所需凭据以及响应的 Retry-After/额度字段。只对漏带认证做一次正确认证请求，不重复匿名请求，不盲目更换出口。不要在结果中输出凭据。]'
}
