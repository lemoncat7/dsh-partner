import type { DirectConfig } from './transport.js'

const cooldowns=new Map<string,number>()
export class LoginRateLimitError extends Error {
  readonly status=429
  constructor(readonly retryAfterMs:number){super(`服务器限制登录频率（HTTP 429），请在 ${Math.ceil(retryAfterMs/1000)} 秒后重试。这不是账号密码错误。`)}
}
async function readLoginBody(response:Response):Promise<any> {
  if(!response.body)throw new Error('登录返回空响应')
  const chunks:Uint8Array[]=[];let bytes=0
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {bytes+=chunk.length;if(bytes>65536)throw new Error('登录响应异常');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Revoke only sessions created by password login, never a user-supplied token. */
export async function discardDirectLogin(config: DirectConfig, token: string): Promise<void> {
  const path = config.platform === 'matrix' ? '/_matrix/client/v3/logout' : '/api/v4/users/logout'
  const response = await fetch(config.baseUrl + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: '{}',
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error('临时登录会话退出失败，请在渠道服务器的会话管理中撤销')
}

/** Exchange a password once. Only the access token is returned to the credential vault. */
export async function directLogin(config: DirectConfig, input: {username: unknown; password: unknown; mfaToken?: unknown}, signal = AbortSignal.timeout(30_000)): Promise<string> {
  if(typeof input.username!=='string'||!input.username.trim()||input.username.length>255||typeof input.password!=='string'||!input.password||input.password.length>8192)throw new Error('请输入账号和密码')
  if(input.mfaToken!==undefined&&(typeof input.mfaToken!=='string'||input.mfaToken.length>64))throw new Error('验证码格式无效')
  const remaining=(cooldowns.get(config.baseUrl)??0)-Date.now()
  if(remaining>0)throw new LoginRateLimitError(remaining)
  const matrix=config.platform==='matrix'
  const response=await fetch(config.baseUrl+(matrix?'/_matrix/client/v3/login':'/api/v4/users/login'),{
    method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json'},
    body:JSON.stringify(matrix?{type:'m.login.password',identifier:{type:'m.id.user',user:input.username.trim()},password:input.password,initial_device_display_name:'DSH Partner'}:{login_id:input.username.trim(),password:input.password,...(input.mfaToken?{token:input.mfaToken}:{})}),
  })
  if(!response.ok) {
    if(response.status===429) {
      const header=response.headers.get('retry-after')
      const headerMs=header?(/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now()):0
      const data=await readLoginBody(response).catch(()=>({}))
      const bodyMs=typeof data.retry_after_ms==='number'?data.retry_after_ms:0
      const retry=Math.max(1000,Number.isFinite(bodyMs)&&bodyMs>0?bodyMs:Number.isFinite(headerMs)&&headerMs>0?headerMs:60_000)
      for(const [key,until] of cooldowns)if(until<=Date.now())cooldowns.delete(key)
      if(cooldowns.size>=128)cooldowns.delete(cooldowns.keys().next().value!)
      cooldowns.set(config.baseUrl,Date.now()+retry)
      throw new LoginRateLimitError(retry)
    }
    await response.body?.cancel()
    throw new Error([400,401,403].includes(response.status)?`账号登录失败（HTTP ${response.status}）。请检查账号、密码及双重验证；仅支持 SSO 的账号请改用 Access Token。`:`登录服务暂不可用（HTTP ${response.status}），请检查服务器或反向代理，不要反复修改密码。`)
  }
  let token: unknown
  if(matrix) {
    token=(await readLoginBody(response)).access_token
  } else {
    token=response.headers.get('Token')
    await response.body?.cancel()
  }
  if(typeof token!=='string'||!token||token.length>8192)throw new Error('服务器未返回可用登录令牌，请改用 Access Token')
  return token
}
