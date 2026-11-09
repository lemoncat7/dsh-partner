export type TtsProvider = 'breezeblue' | 'openai' | 'http'
export interface TtsProfile {
  id:string; name:string; provider:TtsProvider; endpoint:string; model:string; voice:string; language:string; speed:number
  instructions:string; format:'wav'|'mp3'; credentialId?:string|undefined; updatedAt:number
  authHeader:string; authPrefix:string; bodyTemplate?:string|undefined; responseMode:'binary'|'base64'; responsePath:string
}
export interface ChannelTts { enabled:boolean; profileId:string; voice:string }
export interface TtsReceipt { id:string; profileId:string; routeId:string; inputId:string; at:number; status:'generating'|'generated'|'sending'|'confirmed'|'failed'|'unknown'; audioId?:string; mediaType?:string; messageId?:string; spokenText:string }
const string=(v:unknown,max:number,label:string)=>{if(typeof v!=='string'||v.length>max)throw Error(label+'无效');return v.trim()}
export function ttsProfile(raw:Record<string,unknown>,id:string,updatedAt:number,credentialId?:string):TtsProfile {
 const provider=raw.provider as TtsProvider;if(!['breezeblue','openai','http'].includes(provider))throw Error('请选择语音服务类型')
 const endpoint=string(raw.endpoint,2000,'接口地址'),url=new URL(endpoint)
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw Error('接口地址仅支持 HTTP(S)，不要包含密钥、查询参数或片段')
 const name=string(raw.name,80,'服务名称'),voice=string(raw.voice,200,'音色'),model=string(raw.model,100,'模型')
 if(!name||provider!=='http'&&(!voice||!model))throw Error('请填写服务名称、模型和音色')
 const speed=raw.speed??1;if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.5||speed>2)throw Error('语速须为 0.5–2')
 const format=raw.format??'wav';if(!['wav','mp3'].includes(String(format)))throw Error('仅支持 WAV 或 MP3')
 const authHeader=provider==='breezeblue'?'xi-api-key':provider==='openai'?'Authorization':string(raw.authHeader??'Authorization',80,'鉴权头')
 if(!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(authHeader)||/^(host|content-length|content-type|cookie)$/i.test(authHeader))throw Error('鉴权头无效')
 const authPrefix=provider==='breezeblue'?'':provider==='openai'?'Bearer ':String(raw.authPrefix??'Bearer ')
 if(authPrefix.length>30||/[\r\n]/.test(authPrefix))throw Error('鉴权前缀无效')
 const responseMode=raw.responseMode??'binary';if(!['binary','base64'].includes(String(responseMode)))throw Error('响应格式无效')
 const responsePath=string(raw.responsePath??'audio',200,'音频字段路径');if(!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(responsePath))throw Error('音频字段路径无效')
 let bodyTemplate:string|undefined
 if(provider==='http') {bodyTemplate=string(raw.bodyTemplate,20000,'JSON 请求模板');let body:unknown;try{body=JSON.parse(bodyTemplate)}catch{throw Error('JSON 请求模板格式无效')}if(!body||typeof body!=='object'||Array.isArray(body)||!bodyTemplate.includes('{{text}}'))throw Error('请求模板须为 JSON 对象并包含 {{text}}')}
 return {id,name,provider,endpoint:url.href.replace(/\/$/,''),model,voice,language:string(raw.language??'zh',20,'语言'),speed,instructions:string(raw.instructions??'',2000,'表演指令'),format:format as 'wav'|'mp3',updatedAt,credentialId,authHeader,authPrefix,bodyTemplate,responseMode:provider==='http'?responseMode as 'binary'|'base64':'binary',responsePath}
}
export function channelTts(raw:Record<string,unknown>):ChannelTts {
 if(typeof raw.enabled!=='boolean')throw Error('语音开关无效')
 return {enabled:raw.enabled,profileId:string(raw.profileId??'',100,'语音服务'),voice:string(raw.voice??'',200,'音色覆盖')}
}

/** Audio delivery is independent of synthesis provider; social/notification endpoints are not chat recipients. */
export function supportsChannelTts(platform?:string):boolean { return !platform || ['weixin','qq','matrix','mattermost'].includes(platform) }
