import type {PartnerStore} from '../store.js'
import {browserExternalUrl,browserEndpoint, type BrowserConfig} from './domain.js'
import {browserPages,observeBrowserChange} from './observation.js'
import {CdpConnection} from './cdp.js'

const actions = ['status','recent','tabs','open','navigate','inspect','screenshot','click','type','press','scroll','evaluate','close'] as const
export const BROWSER_ACTIONS = [...actions]
export type BrowserAction = typeof actions[number]
export interface BrowserInput { action: BrowserAction; tabId?: string; url?: string; selector?: string; text?: string; key?: string; deltaY?: number; expression?: string }
const pageUrl = (raw: unknown) => {
  if (typeof raw !== 'string' || raw.length > 4096) throw Error('请提供网页 URL')
  const url = new URL(raw)
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw Error('仅支持 HTTP/HTTPS 网页')
  return url.toString()
}
const required = (raw: unknown, label: string, max = 4000) => { if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw Error(label + '无效'); return raw }
const inspection = `(() => {
 const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
 const selector = e => { const parts=[]; while(e && e.nodeType===1){ if(e.id){parts.unshift('#'+CSS.escape(e.id));break} const name=e.tagName.toLowerCase();const peers=e.parentElement?[...e.parentElement.children].filter(x=>x.tagName===e.tagName):[];parts.unshift(name+(peers.length>1?':nth-of-type('+(peers.indexOf(e)+1)+')':''));e=e.parentElement } return parts.join(' > ') };
 const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0,80).map(e=>({tag:e.tagName.toLowerCase(),selector:selector(e),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,160),type:e.getAttribute('type')||undefined,href:e instanceof HTMLAnchorElement?e.href:undefined}));
 return {title:document.title,url:location.href,readyState:document.readyState,text:(document.body?.innerText||'').slice(0,16000),elements};
})()`

export class BrowserService {
  private active = new Map<string, AbortController>()
  private busy = new Set<string>()
  private disposed = false
  constructor(private store: PartnerStore) {}
  config(owner: string): BrowserConfig | undefined {
    const c = this.store.snapshot().companions.find(c => c.id === owner)
    if (!c || this.store.isCompanionRemoving(owner)) throw Error('伙伴不存在')
    return c.browser
  }
  async save(owner: string, raw: Record<string,unknown>): Promise<BrowserConfig> {
    const old = this.config(owner)
    if (raw.expectedUpdatedAt !== (old?.updatedAt ?? 0)) throw Error('浏览器配置已变化，请重新打开配置')
    if (typeof raw.enabled !== 'boolean' || typeof raw.autonomous !== 'boolean') throw Error('浏览器开关无效')
    const externalUrl=raw.externalUrl===undefined?old?.externalUrl:browserExternalUrl(raw.externalUrl)
    const next: BrowserConfig = {...(externalUrl?{externalUrl}:{}),enabled:raw.enabled, autonomous:raw.autonomous, endpoint:browserEndpoint(raw.endpoint), updatedAt:Math.max(Date.now(), (old?.updatedAt ?? 0)+1)}
    await this.store.update(state => {
      const c = state.companions.find(c => c.id === owner)
      if (!c || this.store.isCompanionRemoving(owner) || (c.browser?.updatedAt ?? 0) !== (old?.updatedAt ?? 0)) throw Error('浏览器配置已变化')
      c.browser = next
    })
    this.active.get(owner)?.abort()
    return next
  }
  async test(owner: string, endpoint: unknown, signal: AbortSignal): Promise<unknown> {
    this.config(owner)
    const cdp = await CdpConnection.connect(browserEndpoint(endpoint), AbortSignal.any([signal, AbortSignal.timeout(10000)]))
    try { const r = await cdp.send('Browser.getVersion'); return {connected:true, browser:r.product, protocol:r.protocolVersion} } finally { cdp.close() }
  }
  async run(owner: string, input: BrowserInput, signal: AbortSignal, check: () => void, autonomous = false): Promise<any> {
    check(); signal.throwIfAborted()
    const config = this.config(owner)
    if (!actions.includes(input.action)) throw Error('浏览器操作无效')
    if (input.action === 'status') return {enabled:config?.enabled ?? false, autonomous:config?.autonomous ?? false, configured:!!config, visibility:'public'}
    if (!config?.enabled || autonomous && !config.autonomous) throw Error('浏览器能力未开启，请在渠道 → 通用 → 浏览器中配置')
    if (this.disposed) throw Error('浏览器服务已停止')
    if (this.busy.has(config.endpoint) || this.active.has(owner)) throw Error('浏览器正执行另一项操作，请完成后再试')
    const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(20000)])
    const guard = () => { check(); combined.throwIfAborted(); if (this.disposed || this.config(owner)?.updatedAt !== config.updatedAt) throw Error('浏览器配置已变化，取消旧操作') }
    this.active.set(owner, abort); this.busy.add(config.endpoint)
    let cdp: CdpConnection | undefined
    try {
      cdp = await CdpConnection.connect(config.endpoint, combined, guard)
      const observe=async()=>{try{return browserPages((await cdp!.send('Target.getTargets')).targetInfos)}catch{guard();return undefined}}
      const before=await observe()
      const perform=async()=>{
      if (input.action === 'tabs') { const r = await cdp!.send('Target.getTargets'); return {tabs:r.targetInfos.filter((t:any) => t.type === 'page').map((t:any) => ({id:t.targetId,title:t.title,url:t.url,...(t.openerId?{openerId:t.openerId}:{})})).slice(0,100)} }
      if (input.action === 'open') { const r = await cdp!.send('Target.createTarget', {url:pageUrl(input.url)}); return {tabId:r.targetId,opened:true,notice:'页面可能仍在加载，请 inspect 核对内容'} }
      const tabId = required(input.tabId, '标签页 ID', 200)
      const info = await cdp!.send('Target.getTargetInfo', {targetId:tabId})
      if (info.targetInfo.type !== 'page') throw Error('只能操作网页标签页')
      if (input.action === 'close') return await cdp!.send('Target.closeTarget', {targetId:tabId})
      const {sessionId} = await cdp!.send('Target.attachToTarget', {targetId:tabId,flatten:true})
      const send = (method:string, params:Record<string,unknown> = {}) => cdp!.send(method,params,sessionId)
      const evaluate = async (expression:string) => {
        const r = await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:8000})
        if (r.exceptionDetails) throw Error('页面脚本执行失败：'+String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0,400))
        return r.result.value ?? {type:r.result.type,description:r.result.description}
      }
      if (input.action === 'navigate') { const r = await send('Page.navigate',{url:pageUrl(input.url)}); if(r.errorText)throw Error('页面导航失败：'+r.errorText); return {navigated:true,notice:'请 inspect 核对加载后的页面'} }
      if (input.action === 'inspect') return await evaluate(inspection)
      if (input.action === 'screenshot') { const r = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); if(typeof r.data!=='string'||r.data.length>10*1024*1024)throw Error('浏览器截图过大'); return {image:r.data,mediaType:'image/png'} }
      if (input.action === 'evaluate') { const value = await evaluate(required(input.expression,'JavaScript 表达式',12000)); const encoded=JSON.stringify(value); return encoded.length>24000?{truncated:true,text:encoded.slice(0,24000)}:{value} }
      if (input.action === 'scroll') { if(!Number.isFinite(input.deltaY)||Math.abs(input.deltaY!)>10000)throw Error('滚动距离须在 -10000 到 10000 之间'); await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:100,y:100,deltaX:0,deltaY:input.deltaY}); return {scrolled:true} }
      if (input.action === 'press') {
        const keys:Record<string,number>={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34}
        const key = required(input.key,'按键',20),code=keys[key]
        if(!code)throw Error('不支持的按键')
        await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,...(key==='Enter'?{text:'\r'}:{})}); await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code}); return {pressed:key}
      }
      const selector = required(input.selector,'CSS 选择器',2000)
      if(input.action==='click') {
        const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('未找到元素');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('元素不可见');return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1}); await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1}); return {clicked:true}
      }
      if(input.action==='type') {
        if(typeof input.text!=='string'||input.text.length>12000)throw Error('输入文字无效')
        await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('未找到元素');if(e.disabled||e.readOnly)throw Error('元素不能编辑');e.focus();if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement)e.select();else if(e.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)}else throw Error('元素不是文本输入框');return true})()`)
        if(input.text==='')await evaluate(`(()=>{const e=document.activeElement;if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement){const proto=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))}else document.execCommand('delete');return true})()`)
        else await send('Input.insertText',{text:input.text})
        return {typed:true}
      }
      throw Error('浏览器操作无效')
      }
      const result=await perform()
      const after=input.action==='tabs'?browserPages(result.tabs.map((t:any)=>({...t,targetId:t.id,type:'page'}))):await observe()
      const target=input.action==='open'?result.tabId:input.tabId
      return {...result,browserObservation:observeBrowserChange(config.endpoint,input.action,target,before,after)}
    } finally { cdp?.close(); this.active.delete(owner); this.busy.delete(config.endpoint) }
  }
  close(): void { this.disposed=true; for(const a of this.active.values())a.abort() }
}
