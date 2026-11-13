import {createHash} from 'node:crypto'

export interface BrowserPage {id:string;title:string;url:string;openerId?:string}
export interface BrowserChange {kind:'appeared'|'closed'|'navigated';page:BrowserPage;source:'requested'|'page-opened'|'unknown'}
export interface BrowserObservation {browserId:string;at:number;available:boolean;page?:BrowserPage;related:BrowserPage[];changes:BrowserChange[];truncated:boolean}
export const browserIdentity=(endpoint:string)=>createHash('sha256').update(endpoint).digest('hex').slice(0,20)
export function browserSafeUrl(value:unknown):string {
  try{const u=new URL(String(value));if(!['http:','https:','about:','chrome:'].includes(u.protocol))return '[其他协议页面]';u.username='';u.password='';u.search='';u.hash='';return u.toString().slice(0,400)}catch{return ''}
}
export function browserPages(targets:any[]):BrowserPage[]{
  return targets.filter(t=>t.type==='page'&&typeof t.targetId==='string').slice(0,100).map(t=>({id:t.targetId.slice(0,200),title:String(t.title??'').slice(0,100),url:browserSafeUrl(t.url),...(typeof t.openerId==='string'?{openerId:t.openerId.slice(0,200)}:{})}))
}
export function observeBrowserChange(endpoint:string,action:string,tabId:string|undefined,before:BrowserPage[]|undefined,after:BrowserPage[]|undefined):BrowserObservation {
  const old=new Map((before??[]).map(t=>[t.id,t])),next=new Map((after??[]).map(t=>[t.id,t])),changes:BrowserChange[]=[]
  if(before&&after){
    for(const t of after){const previous=old.get(t.id)
      if(!previous)changes.push({kind:'appeared',page:t,source:action==='open'&&t.id===tabId?'requested':t.openerId?'page-opened':'unknown'})
      else if(previous.url!==t.url)changes.push({kind:'navigated',page:t,source:action==='navigate'&&t.id===tabId?'requested':'unknown'})
    }
    for(const t of before)if(!next.has(t.id))changes.push({kind:'closed',page:t,source:action==='close'&&t.id===tabId?'requested':'unknown'})
  }
  const pages=after??[],page=pages.find(t=>t.id===tabId),related=pages.filter(t=>t.openerId===tabId&&tabId!==undefined)
  // A parent link is evidence of where a page originated, never proof of who clicked or sent a message.
  return {browserId:browserIdentity(endpoint),at:Date.now(),available:!!after,...(page?{page}:{}),related:related.slice(0,4),changes:changes.slice(0,6),truncated:related.length>4||changes.length>6||pages.length>=100}
}
