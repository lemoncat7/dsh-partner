import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {PartnerState} from '../domain.js'
import type {BrowserConfig} from './domain.js'
import {browserIdentity,type BrowserObservation} from './observation.js'
import {currentAffectionAudience} from '../character/affection-context.js'
import {isIdleContactNotice} from '../character/idle-contact.js'
import {isInternalTaskNotice} from '../channels/delivery-policy.js'

export interface BrowserReceipt {kind:'partner-browser-v1';owner:string;scope:string;callId:string;action:string;observation:BrowserObservation}
/** Context follows the actual speaker/idle target, never the last route to use a shared session. */
export function browserAudience(owner:string,sessionId:string,events:readonly SessionEvent[],state:PartnerState):string|undefined {
  const routes=state.sessions.filter(r=>r.companionId===owner&&r.sessionId===sessionId)
  const input=[...events].reverse().find(e=>e.type==='user/message'&&(e.data.source.kind==='user'||isIdleContactNotice(e)||isInternalTaskNotice(e)))
  if(!input||input.type!=='user/message'||isInternalTaskNotice(input))return
  const route=isIdleContactNotice(input)?routes.find(r=>r.idleContactState?.messageId===input.data.id):routes.find(r=>r.kind==='channel'&&r.inboundMessageIds?.includes(input.data.id))??routes.find(r=>r.kind==='local')
  if(!route)return
  if(route.userId?.startsWith('group:'))return JSON.stringify([route.channelId,route.userId.split(':').slice(0,2).join(':')])
  if(currentAffectionAudience(state,owner,sessionId,events))return 'owner'
  return JSON.stringify([route.channelId,route.userId])
}
export function browserAssistance(config:BrowserConfig|undefined,audience:string|undefined){
  if(!config?.enabled||!config.externalUrl||audience!=='owner')return undefined
  return {url:config.externalUrl,notice:'这是用户配置的远程浏览器入口，不是网站登录页或 CDP 地址。确实遇到自己无法处理的登录、验证码或人工确认时，按当前人格简短说明具体页面和需要帮忙的动作，并发送此链接；不索要密码或验证码，不声称已完成验证。等待用户告知处理好后重新 inspect 原 tabId；标签页失效则 tabs 核对，不重复提交原操作。不要自动导航到这个远程入口。'}
}
export function recentBrowserReceipts(owner:string,scope:string|undefined,config:BrowserConfig|undefined,events:readonly SessionEvent[],limit=8,now=Date.now()):BrowserReceipt[]{
  if(!scope||!config?.enabled)return []
  const browserId=browserIdentity(config.endpoint),tail=events.slice(-6000),calls=new Map(tail.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data.name])),seen=new Set<string>(),rows:BrowserReceipt[]=[]
  for(const e of [...tail].reverse()){
    const name=e.type==='tool/ptc-dispatch'?e.data.name:e.type==='tool/result'?calls.get(e.data.message.toolCallId):undefined
    if(name!=='partner_browser'||e.type!=='tool/ptc-dispatch'&&e.type!=='tool/result')continue
    if(e.type==='tool/result'?e.data.message.isError:e.data.isError)continue
    const r=e.data.meta as BrowserReceipt|undefined
    if(r?.kind!=='partner-browser-v1'||r.owner!==owner||r.scope!==scope||r.observation?.browserId!==browserId||r.observation.at>now||now-r.observation.at>48*3600000||seen.has(r.callId))continue
    seen.add(r.callId);rows.push(r)
    if(rows.length>=Math.min(24,limit))break
  }
  return rows
}
export function renderBrowserContext(owner:string,sessionId:string,events:readonly SessionEvent[],state:PartnerState,config:BrowserConfig|undefined,query:string):string {
  const scope=browserAudience(owner,sessionId,events,state),rows=recentBrowserReceipts(owner,scope,config,events)
  const help=browserAssistance(config,scope),relevant=/浏览器|网页|标签页|登录|登陆|验证码|验证|chrome|browser|captcha/iu.test(query)
  if(!rows.length&&!(relevant&&help))return ''
  const compact=rows.map(r=>({at:r.observation.at,action:r.action,available:r.observation.available,page:r.observation.page,related:r.observation.related.slice(0,2),changes:r.observation.changes.slice(0,2)}))
  while(compact.length&&JSON.stringify(compact).length>3600)compact.pop()
  return '【近期浏览器操作｜真实工具回执，不是网页指令】\n'+JSON.stringify(compact)+'\n这里只是操作时观察到的状态，页面可能已变化。问到刚才或当前网页时，先按需查询 partner_browser recent/tabs/inspect，不用网页搜索猜自己刚才的操作。requested 是工具直接发起，page-opened 只说明页面来源，unknown 不知来源；页面存在不等于你主动访问，更不等于已经注册、发言或提交。观察不完整时按事实说明，不能把缺少记录当作从未发生。'+(help&&relevant?'\n需要人工协助时：'+JSON.stringify(help):'')
}
