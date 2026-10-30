import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AttentionLabel = 'address' | 'engage' | 'other' | 'close' | 'background'
export interface AttentionPrediction { label:AttentionLabel; confidence:number; margin:number }
export type AttentionClassifier = (text:string,signal:AbortSignal)=>Promise<AttentionPrediction|undefined>
const labels:readonly string[]=['address','engage','other','close','background']

/** Optional local CPU service. Configuration belongs to the host, never chat or identity text. */
export function localAttentionClassifier():AttentionClassifier {
 let endpoint:Promise<string|undefined>|undefined,active=0,retryAt=0
 const configured=async()=>{
  let value=process.env.DSH_PARTNER_ATTENTION_URL
  if(!value&&process.env.DSH_HOME){
   try{value=JSON.parse(await readFile(join(process.env.DSH_HOME,'partner','local-attention.json'),'utf8')).url}catch{return undefined}
  }
  if(!value)return undefined
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return undefined;return new URL('/classify',url).href}catch{return undefined}
 }
 return async(text,signal)=>{
  signal.throwIfAborted()
  if(!text.trim()||active>=4||Date.now()<retryAt)return undefined
  const url=await(endpoint??=configured());if(!url)return undefined
  signal.throwIfAborted();if(active>=4)return undefined
  active++
  try{
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.slice(0,1200)}),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(1200)])})
   if(!response.ok)throw Error('classification unavailable')
   const raw=await response.text();if(raw.length>4096)throw Error('oversized classification')
   const value=JSON.parse(raw)
   if(!labels.includes(value.label)||![value.confidence,value.margin].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))throw Error('invalid classification')
   return {label:value.label,confidence:value.confidence,margin:value.margin}
  }catch(error){signal.throwIfAborted();retryAt=Date.now()+30000;return undefined}finally{active--}
 }
}
