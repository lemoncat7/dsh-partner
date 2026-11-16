import {randomUUID} from 'node:crypto'
import type {PartnerStore} from '../store.js'
import type {Companion} from '../domain.js'
import type {BrowserService} from '../browser/service.js'
import {idleContactRouteAllowed} from '../character/idle-contact.js'
import {isSleeping} from '../character/sleep.js'
import {continuousState,continuousUsage,terminal,updateObservation,type ContinuousTask,type ContinuousCharge} from './domain.js'

export interface ContinuousReview {scene:string;event:string;evidence:string;speak:boolean;ended:boolean;kind?:'scene'|'companionship'}
export interface ContinuousPorts {
 review(owner:Companion,task:ContinuousTask,signal:AbortSignal,conversation?:string):Promise<ContinuousReview>
 conversation?(task:ContinuousTask):string
 wake(owner:string,task:ContinuousTask):Promise<boolean>
 busy(sessionId:string):boolean
 cancel(task:ContinuousTask):void
 warn(message:string):void
}
const bounded=(raw:unknown,label:string,max:number)=>{if(typeof raw!=='string'||!raw.trim()||raw.length>max)throw Error(label+'无效');return raw.trim()}
export class ContinuousService {
 private timer:ReturnType<typeof setTimeout>|undefined;private closed=false
 private jobs=new Map<string,{abort:AbortController;promise:Promise<void>}>()
 constructor(private store:PartnerStore,private browser:BrowserService,private ports:ContinuousPorts,private now=Date.now){}
 list(owner:string){const c=this.owner(owner),state=c.continuous??continuousState();return {tasks:state.tasks.map(t=>{const {seen,pending,...view}=t;return {...view,pendingCount:pending.length}}),budget:state.budget,used:continuousUsage(state,this.now()),budgetNotice:'每小时共享预算；包含缓存输入与输出。无用量回执时保留请求的保守预留，不自动重试。'}}
 private owner(id:string){const c=this.store.snapshot().companions.find(c=>c.id===id);if(!c||this.store.isCompanionRemoving(id))throw Error('伙伴不存在');return c}
 task(owner:string,id:string){const t=this.owner(owner).continuous?.tasks.find(t=>t.id===id);if(!t)throw Error('持续任务不存在');return t}
 current(owner:string,task:ContinuousTask){
  const c=this.owner(owner),state=this.store.snapshot(),t=c.continuous?.tasks.find(t=>t.id===task.id),r=state.sessions.find(r=>r.id===task.routeId)
  return !!t&&t.status==='running'&&t.revision===task.revision&&!!r&&r.sessionId===task.sessionId&&r.companionId===owner&&idleContactRouteAllowed(state,c,r.id)&&c.browser?.enabled===true&&c.browser.autonomous===true&&c.browser.updatedAt===task.browserRevision
 }
 async create(owner:string,raw:Record<string,unknown>,evidence:string,signal:AbortSignal=new AbortController().signal):Promise<ContinuousTask>{
  const c=this.owner(owner),state=this.store.snapshot(),route=state.sessions.find(r=>r.id===raw.routeId&&r.companionId===owner)
  if(!route||!idleContactRouteAllowed(state,c,route.id))throw Error('请指定当前已授权会话')
  if(!c.browser?.enabled||!c.browser.autonomous)throw Error('请先开启通用浏览器及其自主活动权限')
  const tabId=bounded(raw.tabId,'标签页',200),selector=typeof raw.selector==='string'?raw.selector.trim():''
  if(selector.length>500)throw Error('正文选择器过长')
  const title=bounded(raw.title,'任务名称',100),instruction=bounded(raw.instruction,'陪看要求',400),until=bounded(raw.until,'结束条件',200),sourceEvidence=bounded(evidence,'用户依据',400)
  const abort=AbortSignal.any([signal,AbortSignal.timeout(15000)])
  const page=await this.browser.run(owner,{action:'evaluate',tabId,expression:readExpression(selector)},abort,()=>{if(this.store.isCompanionRemoving(owner))throw Error('伙伴正在删除')},true)
  const value=page.value as {url:string;blocks:string[];title:string}
  if(!value||typeof value.url!=='string'||!/^https?:\/\//i.test(value.url))throw Error('请选择正常网页标签页')
  const now=this.now(),task:ContinuousTask={id:randomUUID(),routeId:route.id,sessionId:route.sessionId,title,instruction,until,tabId,url:value.url.slice(0,4096),selector,browserRevision:c.browser.updatedAt,revision:1,status:'running',phase:'waiting',reason:'',createdAt:now,updatedAt:now,nextCheckAt:now+20000,nextReviewAt:now+120000,failures:0,checks:0,changes:0,reviews:0,wakes:0,seen:[],pending:[],scene:'',lastEvent:'',sourceEvidence}
  updateObservation(task,value.blocks,now)
  task.nextSocialAt=now+15*60000
  let result=task
  await this.store.update(draft=>{
   signal.throwIfAborted()
   const live=draft.companions.find(c=>c.id===owner),r=draft.sessions.find(r=>r.id===route.id)
   if(!live||!r||r.sessionId!==route.sessionId||live.browser?.updatedAt!==task.browserRevision||!idleContactRouteAllowed(draft,live,r.id))throw Error('会话或浏览器配置已变化')
   const s=live.continuous??=continuousState(),same=s.tasks.find(t=>t.routeId===task.routeId&&t.tabId===task.tabId&&!terminal(t))
   if(same){result=same;return}
   if(s.tasks.filter(t=>!terminal(t)).length>=3)throw Error('每个伙伴最多同时保留 3 个持续任务，请先停止不需要的任务')
   s.tasks=[...s.tasks.filter(t=>!terminal(t)),...s.tasks.filter(terminal).slice(-20),task]
  })
  return result
 }
 async control(owner:string,id:string,action:'pause'|'resume'|'stop'|'complete',reason='',expected?:number){
  const before=this.task(owner,id)
  if(expected!==undefined&&before.revision!==expected)throw Error('任务已变化，请刷新')
  if(action==='resume'&&terminal(before))throw Error('已结束任务不能自动恢复，请新建任务')
  await this.store.update(state=>{const t=state.companions.find(c=>c.id===owner)?.continuous?.tasks.find(t=>t.id===id);if(!t||t.revision!==before.revision)throw Error('任务已变化');t.status=action==='pause'?'paused':action==='resume'?'running':action==='complete'?'completed':'stopped';t.revision++;t.updatedAt=this.now();t.reason=reason.slice(0,300)||({pause:'已暂停',resume:'继续观察',stop:'已手动停止',complete:'已确认活动结束'}[action]);t.phase='waiting';t.nextCheckAt=this.now();delete t.claim;delete t.pendingEvent;if(action!=='resume')t.pending=[]})
  this.jobs.get(id)?.abort.abort();this.ports.cancel(before)
 }
 async budget(owner:string,value:number){if(!Number.isInteger(value)||value<10000||value>200000)throw Error('每小时预算须为 10000–200000');await this.store.update(s=>{const c=s.companions.find(c=>c.id===owner);if(!c)throw Error('伙伴不存在');(c.continuous??=continuousState()).budget=value;for(const t of c.continuous.tasks){delete t.budgetUntil;if(t.phase==='budget'){t.phase='waiting';t.reason='预算已调整，等待下次检查'}}})}
 budgetResetAt(owner:string):number {const rows=this.owner(owner).continuous?.charges.filter(x=>this.now()-x.at<3600000)??[];return rows.length?Math.min(...rows.map(x=>x.at))+3600000:this.now()+3600000}
 async reserve(owner:string,amount:number,kind:ContinuousCharge['kind']):Promise<string|undefined>{
  let id:string|undefined
  await this.store.update(s=>{const c=s.companions.find(c=>c.id===owner);if(!c)return;const state=c.continuous??=continuousState(),now=this.now();state.charges=state.charges.filter(x=>now-x.at<3600000);if(amount<=0||!Number.isFinite(amount)||state.charges.length>=512||continuousUsage(state,now)+amount>state.budget)return;id=randomUUID();state.charges.push({id,at:now,reserved:Math.ceil(amount),kind})})
  return id
 }
 async settle(owner:string,id:string,used:number){if(!Number.isFinite(used)||used<0)return;await this.store.update(s=>{const x=s.companions.find(c=>c.id===owner)?.continuous?.charges.find(c=>c.id===id);if(x)x.used=Math.ceil(used)})}
 async recover(){await this.store.update(s=>{for(const c of s.companions){for(const t of c.continuous?.tasks??[]){if(t.status!=='running')continue;t.revision++;delete t.claim;delete t.pendingEvent;t.nextCheckAt=this.now()+20000;t.reason='服务已恢复，先核对来源，不重发旧消息'}for(const r of s.sessions)if(r.companionId===c.id&&r.idleContactState?.kind==='continuous')r.idleContactState.cancelled=true}})}
 async patch(owner:string,id:string,revision:number,change:(task:ContinuousTask)=>void){await this.store.update(s=>{const t=s.companions.find(c=>c.id===owner)?.continuous?.tasks.find(t=>t.id===id);if(t?.revision===revision&&t.status==='running')change(t)})}
 start(){if(this.closed||this.timer)return;const loop=()=>{this.timer=undefined;if(this.closed)return;this.tick();this.timer=setTimeout(loop,5000);this.timer.unref?.()};this.timer=setTimeout(loop,5000);this.timer.unref?.()}
 tick(){
  if(this.closed)return
  for(const c of this.store.snapshot().companions)for(const t of c.continuous?.tasks??[]){
   if(this.jobs.size>=2)return
   if(t.status!=='running'||t.nextCheckAt>this.now()||this.jobs.has(t.id))continue
   const abort=new AbortController(),promise=this.check(c.id,t,abort.signal).catch(e=>this.ports.warn('持续任务检查失败：'+String(e).slice(0,150))).finally(()=>this.jobs.delete(t.id))
   this.jobs.set(t.id,{abort,promise})
  }
 }
 async check(owner:string,task:ContinuousTask,signal:AbortSignal){
  const guard=()=>{signal.throwIfAborted();if(this.closed||!this.current(owner,task))throw Error('任务、权限或浏览器配置已变化')}
  try{
   guard()
   const page=await this.browser.run(owner,{action:'evaluate',tabId:task.tabId,expression:readExpression(task.selector)},signal,guard,true)
   guard();const value=page.value as {url:string;blocks:string[]}
   if(value?.url?.split('#')[0]!==task.url.split('#')[0])throw Error('标签页已转到其他页面，请核对后重新建立任务')
   await this.patch(owner,task.id,task.revision,t=>{const reason=t.reason;updateObservation(t,value.blocks,this.now());if(t.budgetUntil&&this.now()<t.budgetUntil){t.phase='budget';t.reason=reason}else{t.phase='waiting';delete t.budgetUntil}t.nextCheckAt=this.now()+20000})
   const next=this.task(owner,task.id),c=this.owner(owner)
   if(next.budgetUntil&&this.now()<next.budgetUntil)return
   if(next.pendingEvent){await this.deliverPending(owner,next,signal);return}
   if(this.ports.busy(task.sessionId))return
   const socialDue=this.now()>=(next.nextSocialAt??next.createdAt+15*60000)
   if(!next.pending.length&&!socialDue||next.nextReviewAt>this.now()||isSleeping(c))return
   guard();await this.patch(owner,task.id,task.revision,t=>{t.phase='checking';t.nextReviewAt=this.now()+180000})
   const result=await this.ports.review(c,next,signal,this.ports.conversation?.(next));guard()
   const validEvidence=result.evidence.trim()&&next.pending.some(p=>p.includes(result.evidence.trim()))
   const companionship=result.kind==='companionship'
   await this.patch(owner,task.id,task.revision,t=>{t.reviews++;t.reviewedAt=this.now();if(validEvidence)t.scene=result.scene.slice(0,1000);t.pending=[];t.phase='waiting';t.reason=result.speak&&validEvidence?'发现可聊的新内容':'已理解新增内容，暂不打扰';if(validEvidence){t.lastEvidence=result.evidence.slice(0,500);if(result.ended)t.endEvidence=result.evidence.slice(0,500)}})
   await this.patch(owner,task.id,task.revision,t=>{t.nextSocialAt=this.now()+15*60000})
   if(result.ended&&validEvidence){await this.control(owner,task.id,'complete','来源内容符合结束条件：'+result.evidence.slice(0,180),task.revision);return}
   if(!result.speak||!validEvidence&&!companionship||!result.event.trim()||!companionship&&result.event===task.lastEvent)return
   const event=companionship?'持续陪伴的交流时机：参考当前真实时间、最近对话与已有观察，自主决定是否关心、表达感受或分享；没有新的战报依据，不编造新战况。':result.event.slice(0,600)
   await this.patch(owner,task.id,task.revision,t=>{t.pendingEvent={text:event,evidence:companionship?'程序核验：任务仍在观察，交流时间见当前会话记录':result.evidence.slice(0,500),at:this.now()};t.phase='ready'})
   await this.deliverPending(owner,this.task(owner,task.id),signal)
  }catch(error){
   if(signal.aborted||this.closed)return
   await this.patch(owner,task.id,task.revision,t=>{t.failures++;t.phase=/预算/.test(String(error))?'budget':'blocked';if(t.phase==='budget')t.budgetUntil=this.budgetResetAt(owner);t.reason=(error instanceof Error?error.message:String(error)).slice(0,300);t.nextCheckAt=this.now()+Math.min(300000,20000*2**Math.min(t.failures,4))})
  }
 }
 private async deliverPending(owner:string,task:ContinuousTask,signal:AbortSignal){
  const pending=task.pendingEvent;if(!pending||signal.aborted||!this.current(owner,task))return
  if(this.now()-pending.at>10*60000){await this.patch(owner,task.id,task.revision,t=>{delete t.pendingEvent;t.reason='较早的接话机会已过期，继续观察新内容'});return}
  if(this.ports.busy(task.sessionId)||isSleeping(this.owner(owner)))return
  const woke=await this.ports.wake(owner,{...task,lastEvent:pending.text,lastEvidence:pending.evidence})
  if(signal.aborted||!this.current(owner,task))return
  await this.patch(owner,task.id,task.revision,t=>{if(woke){t.wakes++;t.wakeAt=this.now();t.lastEvent=pending.text;t.reason='新场景已交给原会话，由伙伴决定是否开口';delete t.pendingEvent}else{t.phase='ready';t.reason='等待合适的接话时机，未重复调用判断模型'}})
 }
 async close(){this.closed=true;for(const c of this.store.snapshot().companions)for(const t of c.continuous?.tasks??[])if(t.status==='running')this.ports.cancel(t);if(this.timer)clearTimeout(this.timer);for(const j of this.jobs.values())j.abort.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.promise))}
}
export function readExpression(selector:string):string {
 return `(()=>{const root=document.querySelector(${JSON.stringify(selector||'article')})||${selector?'null':"document.querySelector('main')||document.body"};if(!root)throw Error('未找到正文区域');const copy=root.cloneNode(true);copy.querySelectorAll('script,style,nav,header,footer,aside,button,input,iframe,[role="navigation"],[aria-hidden="true"],.advertisement,.ad').forEach(e=>e.remove());let blocks=[...copy.querySelectorAll('p,h1,h2,h3,li')].map(e=>e.textContent||'');if(!blocks.length)blocks=(copy.textContent||'').split(/\\n+/);if(!${JSON.stringify(selector)}){const collect=(v,depth=0)=>{if(depth>4||!v||typeof v!=='object')return;if(Array.isArray(v)){v.slice(0,128).forEach(x=>collect(x,depth+1));return}if(v.liveBlogUpdate){for(const u of (Array.isArray(v.liveBlogUpdate)?v.liveBlogUpdate:[v.liveBlogUpdate]).slice(0,128)){if(!u||typeof u!=='object')continue;const raw=[u.headline,u.articleBody,u.text].filter(x=>typeof x==='string').join(' ');if(raw)blocks.push(raw.slice(0,10000).replace(/<[^>]*>/g,' '))}}if(v['@graph'])collect(v['@graph'],depth+1)};for(const el of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,20)){try{if(el.textContent.length<=200000)collect(JSON.parse(el.textContent))}catch{}}}const selected=blocks.length>128?[...blocks.slice(0,64),...blocks.slice(-64)]:blocks;let size=0;return {url:location.href,title:document.title,blocks:selected.map(s=>s.trim().slice(0,600)).filter(s=>{if(size+s.length>14000)return false;size+=s.length;return true})}})()`
}
