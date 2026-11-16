import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AttentionLabel = 'address' | 'engage' | 'other' | 'close' | 'background'
export interface AttentionPrediction { label:AttentionLabel; confidence:number; margin:number; contextSimilarity?:number }
export interface AttentionDiagnostic {status:'ok'|'empty'|'busy'|'backoff'|'timeout'|'transport'|'http'|'invalid'|'unconfigured';attempts:number;retryAfterMs?:number}
export type AttentionClassifier = (text:string,signal:AbortSignal,context?:readonly string[],report?:(diagnostic:AttentionDiagnostic)=>void)=>Promise<AttentionPrediction|undefined>
const labels:readonly string[]=['address','engage','other','close','background']

/** Optional local CPU service. Configuration belongs to the host, never chat or identity text. */
export function localAttentionClassifier(now=Date.now):AttentionClassifier {
 let endpoint:Promise<string|undefined>|undefined,active=0,retryAt=0,failures=0
 const configured=async()=>{
  let value=process.env.DSH_PARTNER_ATTENTION_URL
  if(!value&&process.env.DSH_HOME){
   try{value=JSON.parse(await readFile(join(process.env.DSH_HOME,'partner','local-attention.json'),'utf8')).url}catch{return undefined}
  }
  if(!value)return undefined
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return undefined;return new URL('/classify',url).href}catch{return undefined}
 }
 return async(text,signal,context=[],report)=>{
  signal.throwIfAborted()
  if(!text.trim()){report?.({status:'empty',attempts:0});return}
  if(active>=4){report?.({status:'busy',attempts:0});return}
  if(now()<retryAt){report?.({status:'backoff',attempts:0,retryAfterMs:retryAt-now()});return}
  const url=await(endpoint??=configured());if(!url){report?.({status:'unconfigured',attempts:0});return}
  signal.throwIfAborted();if(active>=4){report?.({status:'busy',attempts:0});return}
  active++
  let status:AttentionDiagnostic['status']='transport',attempts=0
  try{
   // Read-only classification may retry a transient transport failure once within 700 ms.
   // Keep one concurrency slot across both attempts; never queue behind an outage.
   for(const budget of [450,250]){
    attempts++
    const timeout=AbortSignal.timeout(budget)
    try{
     const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.slice(0,1200),context:context.slice(-4).map(t=>t.slice(0,48))}),redirect:'error',signal:AbortSignal.any([signal,timeout])})
     if(!response.ok){await response.body?.cancel();status='http';break}
     const raw=await response.text()
     if(raw.length>4096){status='invalid';break}
     let value
     try{value=JSON.parse(raw)}catch{status='invalid';break}
     if(!labels.includes(value.label)||![value.confidence,value.margin].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)){status='invalid';break}
     const contextSimilarity=typeof value.contextSimilarity==='number'&&Number.isFinite(value.contextSimilarity)&&value.contextSimilarity>=0&&value.contextSimilarity<=1?value.contextSimilarity:undefined
     failures=0;retryAt=0;report?.({status:'ok',attempts})
     return {label:value.label,confidence:value.confidence,margin:value.margin,...(contextSimilarity!==undefined?{contextSimilarity}:{})}
    }catch(error){signal.throwIfAborted();status=timeout.aborted?'timeout':'transport'}
   }
   const retryAfterMs=Math.min(8000,1000*2**Math.min(failures++,3));retryAt=now()+retryAfterMs
   report?.({status,attempts,retryAfterMs});return undefined
  }finally{active--}
 }
}
