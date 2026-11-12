import {withSpeechTail} from './audio-tail.js'
import type {TtsProfile} from './domain.js'
export const MAX_AUDIO_BYTES=10*1024*1024
export function audioType(bytes:Buffer):'audio/wav'|'audio/mpeg' {
 if(bytes.length>=44&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE'){
  let offset=12,fmt=false,data=false
  while(offset+8<=bytes.length){const size=bytes.readUInt32LE(offset+4);if(offset+8+size>bytes.length)throw Error('WAV 数据不完整');const tag=bytes.toString('ascii',offset,offset+4);if(tag==='fmt '&&size>=16)fmt=true;if(tag==='data'&&size>0)data=true;offset+=8+size+(size%2)}
  if(fmt&&data)return 'audio/wav'
 }
 if(bytes.length>32&&(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]!&0xe0)===0xe0))return 'audio/mpeg'
 throw Error('TTS 返回的内容不是有效的 WAV/MP3 音频，未发送')
}
export function ttsRequest(p:TtsProfile,text:string,voice=p.voice):{url:string;body:unknown} {
 if(p.provider==='breezeblue')return {url:p.endpoint+'/v1/text-to-speech/'+encodeURIComponent(voice)+'?output_format='+p.format+'&delivery=sync',body:{text,model_id:p.model,language_code:p.language,...(p.instructions?{instructions:p.instructions}:{}),voice_settings:{speed:p.speed}}}
 if(p.provider==='openai')return {url:p.endpoint+'/audio/speech',body:{input:text,model:p.model,voice,response_format:p.format,speed:p.speed,...(p.instructions?{instructions:p.instructions}:{})}}
 const values:Record<string,unknown>={text,voice,model:p.model,speed:p.speed,language:p.language,instructions:p.instructions,format:p.format}
 const fill=(v:unknown):unknown=>typeof v==='string'?v.replace(/\{\{(text|voice|model|speed|language|instructions|format)\}\}/g,(_,k)=>String(values[k])):Array.isArray(v)?v.map(fill):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,v])=>[k,typeof v==='string'&&/^\{\{speed\}\}$/.test(v)?p.speed:fill(v)])):v
 return {url:p.endpoint,body:fill(JSON.parse(p.bodyTemplate!))}
}
async function bounded(response:Response,limit:number):Promise<Buffer>{
 if(Number(response.headers.get('content-length')??0)>limit){await response.body?.cancel();throw Error('TTS 响应超过大小限制')}
 if(!response.body)throw Error('TTS 返回空响应')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('TTS 响应超过大小限制');chunks.push(value)}}catch(e){await reader.cancel().catch(()=>{});throw e}finally{reader.releaseLock()}
 return Buffer.concat(chunks)
}
export async function synthesize(p:TtsProfile,key:string,text:string,voice:string,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<{data:Buffer;mediaType:string}>{
 if(!text.trim()||text.length>2000)throw Error('语音正文须为 1–2000 字')
 const request=ttsRequest(p,text,voice)
 let r:Response
 try{r=await fetcher(request.url,{method:'POST',headers:{'Content-Type':'application/json',...(key?{[p.authHeader]:p.authPrefix+key}:{})},body:JSON.stringify(request.body),redirect:'error',signal})}catch{throw Error('TTS 请求未确认完成；未自动重试，请先核对服务记录')}
 if(!r.ok){await r.body?.cancel();throw Error(`TTS 服务返回 HTTP ${r.status}，未发送语音`)}
 let bytes=await bounded(r,p.responseMode==='base64'?Math.ceil(MAX_AUDIO_BYTES*1.4)+65536:MAX_AUDIO_BYTES)
 if(p.responseMode==='base64'){
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));for(const k of p.responsePath.split('.'))value=value&&typeof value==='object'&&Object.hasOwn(value,k)?(value as Record<string,unknown>)[k]:undefined}catch{throw Error('TTS JSON 响应无效')}
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(MAX_AUDIO_BYTES*1.4)||! /^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('TTS Base64 音频字段无效')
  bytes=Buffer.from(value,'base64')
 }else if(!/^audio\//i.test(r.headers.get('content-type')??'')&&!/application\/octet-stream/i.test(r.headers.get('content-type')??''))throw Error('TTS 响应不是音频类型')
 if(bytes.length>MAX_AUDIO_BYTES)throw Error('TTS 音频超过大小限制')
 const mediaType=audioType(bytes)
 return {data:mediaType==='audio/wav'?withSpeechTail(bytes,MAX_AUDIO_BYTES):bytes,mediaType}
}
