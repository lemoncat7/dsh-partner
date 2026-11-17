import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AttentionLabel = 'address' | 'engage' | 'other' | 'close' | 'background'
export type AttentionScene = 'address'|'question'|'banter'|'share'|'topic'|'close'|'other'|'background'
export interface ScenePrediction {label:AttentionScene;confidence:number;margin:number}
export function isClearScene(scene:ScenePrediction|undefined):boolean {return !!scene&&(scene.confidence>=.6&&scene.margin>=.2||scene.confidence>=.5&&scene.margin>=.25)}
export interface AttentionFrame {profile?:readonly string[];partnerText?:string}
export interface AttentionPrediction { label:AttentionLabel; confidence:number; margin:number; contextSimilarity?:number;replySimilarity?:number;profileSimilarity?:number;scene?:ScenePrediction }
/** Use the same call evidence for admission, busy queues and interjection limits. */
export function isAttentionCall(prediction:AttentionPrediction|undefined):boolean {
 if(!prediction)return false
 // These heads are uncalibrated rankings, not probabilities of a correct answer.
 // Correlated heads agreeing is insufficient alone: require support from the
 // current persona or delivered conversation when relaxing the score cutoff.
 const relevant=(prediction.profileSimilarity??0)>=.45||(prediction.replySimilarity??0)>=.4||(prediction.contextSimilarity??0)>=.4
 if(prediction.label==='address'&&prediction.scene?.label==='address'&&relevant)return true
 const addressed=prediction.label==='address'&&(prediction.confidence>=.65&&prediction.margin>=.15||prediction.confidence>=.58&&prediction.margin>=.2||prediction.confidence>=.45&&prediction.margin>=.25||prediction.confidence>=.48&&prediction.margin>=.12&&(prediction.contextSimilarity??0)>=.4)
 const strongOther=prediction.scene?.label==='other'&&prediction.scene.confidence>=.8&&prediction.scene.margin>=.5
 const supported=prediction.confidence>=.65&&prediction.margin>=.15||prediction.confidence>=.48&&prediction.margin>=.12&&(prediction.contextSimilarity??0)>=.4
 // Scene and address heads score the same text independently. A negative scene
 // cannot erase contextual evidence that the speaker is addressing the partner.
 return addressed&&(!strongOther||supported)||isClearScene(prediction.scene)&&prediction.scene!.label==='address'
}
export interface AttentionDiagnostic {status:'ok'|'empty'|'busy'|'backoff'|'timeout'|'transport'|'http'|'invalid'|'unconfigured';attempts:number;retryAfterMs?:number}
export type AttentionClassifier = (text:string,signal:AbortSignal,context?:readonly string[],report?:(diagnostic:AttentionDiagnostic)=>void,frame?:AttentionFrame)=>Promise<AttentionPrediction|undefined>
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
 return async(text,signal,context=[],report,frame)=>{
  signal.throwIfAborted()
  if(!text.trim()){report?.({status:'empty',attempts:0});return}
  if(active>=4){report?.({status:'busy',attempts:0});return}
  if(now()<retryAt){report?.({status:'backoff',attempts:0,retryAfterMs:retryAt-now()});return}
  const url=await(endpoint??=configured());if(!url){report?.({status:'unconfigured',attempts:0});return}
  signal.throwIfAborted();if(active>=4){report?.({status:'busy',attempts:0});return}
  active++
  let status:AttentionDiagnostic['status']='transport',attempts=0
  try{
   // A cold local model may need about one second. Share one 1.5s deadline;
   // retry a dropped connection only, never duplicate inference after a timeout.
   const started=performance.now()
   for(let attempt=0;attempt<2;attempt++){
    const budget=1500-(performance.now()-started);if(budget<=0){status='timeout';break}
    attempts++
    const timeout=AbortSignal.timeout(Math.ceil(budget))
    try{
     const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text.slice(0,1200),context:context.slice(-4).map(t=>t.slice(0,48)),...(frame?{frame:{profile:(frame.profile??[]).slice(0,3).map(t=>t.slice(0,160)),partnerText:(frame.partnerText??'').slice(0,160)}}:{})}),redirect:'error',signal:AbortSignal.any([signal,timeout])})
     if(!response.ok){await response.body?.cancel();status='http';break}
     const raw=await response.text()
     if(raw.length>4096){status='invalid';break}
     let value
     try{value=JSON.parse(raw)}catch{status='invalid';break}
     if(!labels.includes(value.label)||![value.confidence,value.margin].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1)){status='invalid';break}
     const contextSimilarity=typeof value.contextSimilarity==='number'&&Number.isFinite(value.contextSimilarity)&&value.contextSimilarity>=0&&value.contextSimilarity<=1?value.contextSimilarity:undefined
     const fraction=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1
     const scene=value.scene&&['address','question','banter','share','topic','close','other','background'].includes(value.scene.label)&&fraction(value.scene.confidence)&&fraction(value.scene.margin)?{label:value.scene.label,confidence:value.scene.confidence,margin:value.scene.margin}:undefined
     failures=0;retryAt=0;report?.({status:'ok',attempts})
     return {label:value.label,confidence:value.confidence,margin:value.margin,...(contextSimilarity!==undefined?{contextSimilarity}:{}),...(fraction(value.replySimilarity)?{replySimilarity:value.replySimilarity}:{}),...(fraction(value.profileSimilarity)?{profileSimilarity:value.profileSimilarity}:{}),...(scene?{scene}:{})}
    }catch(error){signal.throwIfAborted();status=timeout.aborted?'timeout':'transport';if(timeout.aborted)break}
   }
   const retryAfterMs=Math.min(8000,1000*2**Math.min(failures++,3));retryAt=now()+retryAfterMs
   report?.({status,attempts,retryAfterMs});return undefined
  }finally{active--}
 }
}
