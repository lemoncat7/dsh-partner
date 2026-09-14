import {createHmac, randomBytes} from 'node:crypto'
import {directLogin, discardDirectLogin} from './login.js'
import type {DirectConfig} from './transport.js'

/** Short-lived server-only sessions: tests and save share one login, never
 * return credentials to the browser or retain plaintext passwords. */
export class DirectLoginCache {
  private readonly salt=randomBytes(32)
  private readonly entries=new Map<string,{token:Promise<string>;timer:ReturnType<typeof setTimeout>}>()
  constructor(private readonly ttl=5*60_000,private readonly login=directLogin,private readonly logout=discardDirectLogin){}

  async acquire(scope:string,config:DirectConfig,input:{username:unknown;password:unknown;mfaToken?:unknown}):Promise<{token:string;retain():void}> {
    const key=createHmac('sha256',this.salt).update(JSON.stringify([scope,config.platform,config.baseUrl,input.username,input.password,input.mfaToken])).digest('hex')
    let entry=this.entries.get(key)
    if(!entry) {
      if(this.entries.size>=32)throw new Error('待保存的渠道登录过多，请稍后重试')
      const token=this.login(config,input)
      const timer=setTimeout(()=>{
        if(this.entries.get(key)?.token!==token)return
        this.entries.delete(key)
        void token.then(value=>this.logout(config,value)).catch(()=>{})
      },this.ttl)
      timer.unref()
      entry={token,timer};this.entries.set(key,entry)
      void token.catch(()=>{if(this.entries.get(key)===entry){clearTimeout(timer);this.entries.delete(key)}})
    }
    const current=entry
    return {token:await current.token,retain:()=>{clearTimeout(current.timer);if(this.entries.get(key)===current)this.entries.delete(key)}}
  }
}
