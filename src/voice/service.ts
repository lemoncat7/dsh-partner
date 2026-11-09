import {createHash,randomUUID} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {PartnerStore} from '../store.js'
import type {TtsCredentials} from './credentials.js'
import type {PartnerOutboundAttachment} from '../channel-message.js'
import {supportsChannelTts,channelTts,ttsProfile,type TtsProfile,type TtsReceipt} from './domain.js'
import {extractOutboundAttachments} from '../channels/outbound-media.js'
import {readOutboundMedia} from '../channels/direct/media.js'
import {audioType,synthesize,MAX_AUDIO_BYTES} from './synthesize.js'
export class TtsService {
 private edits=new Set<string>();private jobs=new Map<string,Promise<TtsReceipt>>()
 constructor(readonly store:PartnerStore,private vault:TtsCredentials,private directory:string,private fetcher:typeof fetch=fetch){}
 private owner(id:string){const c=this.store.snapshot().companions.find(c=>c.id===id);if(!c||this.store.isCompanionRemoving(id))throw Error('伙伴不存在');return c}
 list(owner:string){return (this.owner(owner).ttsProfiles??[]).map(({credentialId,...p})=>({...p,credentialConfigured:!!credentialId}))}
 profile(owner:string,id:string){const p=this.owner(owner).ttsProfiles?.find(p=>p.id===id);if(!p)throw Error('语音服务不存在');return p}
 async save(owner:string,raw:Record<string,unknown>):Promise<unknown>{
  if(this.edits.has(owner))throw Error('语音服务正在保存，请稍后');this.edits.add(owner)
  let fresh:string|undefined,committed=false
  try{
   const c=this.owner(owner),id=typeof raw.id==='string'&&raw.id?raw.id:randomUUID(),old=c.ttsProfiles?.find(p=>p.id===id)
   if(raw.id&&!old)throw Error('语音服务不存在')
   if(old&&raw.expectedUpdatedAt!==old.updatedAt)throw Error('语音服务已变化，请刷新后重试')
   if(!old&&(c.ttsProfiles?.length??0)>=20)throw Error('每个伙伴最多保存 20 个语音服务')
   if(raw.apiKey!==undefined&&(typeof raw.apiKey!=='string'||raw.apiKey.length>4096||/[\r\n]/.test(raw.apiKey)))throw Error('密钥格式无效')
   const key=typeof raw.apiKey==='string'?raw.apiKey.trim():''
   let credentialId=old?.credentialId
   const p=ttsProfile(raw,id,Math.max(Date.now(),(old?.updatedAt??0)+1),credentialId)
   if(old&&old.endpoint!==p.endpoint&&!key&&credentialId)throw Error('更换接口地址时请重新填写密钥，避免把原密钥发到新服务')
   if(key){fresh=randomUUID();await this.vault.write(fresh,key);p.credentialId=fresh}
   if(!p.credentialId&&p.provider!=='http')throw Error('请填写 API 密钥')
   await this.store.update(state=>{const current=state.companions.find(c=>c.id===owner);if(!current||this.store.isCompanionRemoving(owner))throw Error('伙伴已移除');const rows=current.ttsProfiles??=[];if(rows.find(x=>x.id===id)?.updatedAt!==old?.updatedAt)throw Error('语音服务已变化');const i=rows.findIndex(x=>x.id===id);if(i<0)rows.push(p);else rows[i]=p})
   committed=true
   if(fresh&&old?.credentialId)await this.vault.delete(old.credentialId).catch(()=>{})
   return this.list(owner).find(p=>p.id===id)
  }finally{if(fresh&&!committed)await this.vault.delete(fresh).catch(()=>{});this.edits.delete(owner)}
 }
 async remove(owner:string,id:string,expected:unknown){
  if(this.edits.has(owner))throw Error('语音服务正在保存');this.edits.add(owner)
  try{const p=this.profile(owner,id);if(expected!==p.updatedAt)throw Error('语音服务已变化');await this.store.update(state=>{if(state.channels.some(c=>c.companionId===owner&&c.tts?.profileId===id))throw Error('该服务仍被渠道引用，请先切换渠道服务');const c=state.companions.find(c=>c.id===owner);if(!c||c.ttsProfiles?.find(p=>p.id===id)?.updatedAt!==expected)throw Error('语音服务已变化');c.ttsProfiles=c.ttsProfiles.filter(p=>p.id!==id)});if(p.credentialId)await this.vault.delete(p.credentialId).catch(()=>{})}finally{this.edits.delete(owner)}
 }
 async configure(channelId:string,raw:Record<string,unknown>){
  const config=channelTts(raw)
  await this.store.update(state=>{const c=state.channels.find(c=>c.id===channelId);if(!c||!supportsChannelTts(c.platform))throw Error('此渠道不支持聊天音频交付');if(c.updatedAt!==raw.expectedUpdatedAt)throw Error('渠道配置已变化，请刷新');if(config.enabled&&!state.companions.find(p=>p.id===c.companionId)?.ttsProfiles?.some(p=>p.id===config.profileId))throw Error('请选择已保存的语音服务');c.tts=config;c.updatedAt=Math.max(Date.now(),c.updatedAt+1)})
 }
 async preview(owner:string,id:string,text:string,signal:AbortSignal){const p=this.profile(owner,id);const result=await this.generate(p,text,p.voice,signal);if(this.profile(owner,id).updatedAt!==p.updatedAt)throw Error('服务配置已变化，试听已丢弃');return result}
 private async generate(p:TtsProfile,text:string,voice:string,signal:AbortSignal){const key=p.credentialId?await this.vault.read(p.credentialId):'';return synthesize(p,key,text,voice,AbortSignal.any([signal,AbortSignal.timeout(180000)]),this.fetcher)}
 async recover(){await this.store.update(state=>{for(const c of state.channels)for(const r of c.ttsReceipts??[])if(r.status==='generating'||r.status==='sending')r.status='unknown'})}
 async deliver(input:{owner:string;channelId:string;routeId:string;inputId:string;text:string;voice?:string|undefined;signal:AbortSignal;guard:()=>void;send:(data:Buffer,signal:AbortSignal,guard:()=>void,file:PartnerOutboundAttachment)=>Promise<string|{confirmed:true;messageId?:string}>}):Promise<TtsReceipt>{
  input.guard();const c=this.store.snapshot().channels.find(c=>c.id===input.channelId)!,p=this.profile(input.owner,c.tts!.profileId)
  const voice=input.voice||c.tts?.voice||p.voice
  if(voice.length>200)throw Error('音色 ID 过长')
  const id=createHash('sha256').update(JSON.stringify([input.channelId,input.routeId,input.inputId,input.text,voice,p.id,p.updatedAt])).digest('hex')
  const guard=()=>{input.signal.throwIfAborted();input.guard();if(this.profile(input.owner,p.id).updatedAt!==p.updatedAt)throw Error('语音服务配置已变化，取消旧投递')}
  const prior=this.jobs.get(id);if(prior){const r=await prior;guard();return r}
  const job=this.perform(id,p,voice,input,guard);this.jobs.set(id,job)
  try{return await job}finally{this.jobs.delete(id)}
 }
 async deliverFile(input:Parameters<TtsService['deliver']>[0]&{cwd:string;path:string}):Promise<TtsReceipt>{
  input.guard()
  const files=await extractOutboundAttachments(`[audio](<${input.path}>)`,input.cwd)
  const file=files[0];if(!file||files.length!==1||!['audio/wav','audio/mpeg'].includes(file.mediaType))throw Error('请提供当前会话目录内的 WAV/MP3 音频文件')
  const data=await readOutboundMedia(file,input.signal)
  if(data.length>MAX_AUDIO_BYTES)throw Error('语音文件超过 10 MB')
  const prepared={data,mediaType:audioType(data)}
  input.guard()
  const id=createHash('sha256').update(JSON.stringify(['file',input.owner,input.channelId,input.routeId,input.inputId])).update(data).digest('hex')
  const prior=this.jobs.get(id);if(prior){const result=await prior;input.guard();return result}
  const job=this.perform(id,undefined,'',input,input.guard,prepared);this.jobs.set(id,job)
  try{return await job}finally{this.jobs.delete(id)}
 }
 private async perform(id:string,p:TtsProfile|undefined,voice:string,input:Parameters<TtsService['deliver']>[0],guard:()=>void,prepared?:{data:Buffer;mediaType:string}):Promise<TtsReceipt>{
  let receipt:TtsReceipt|undefined,created=false
  const update=async(patch:Partial<TtsReceipt>)=>{await this.store.update(state=>{const r=state.channels.find(c=>c.id===input.channelId)?.ttsReceipts?.find(r=>r.id===id);if(!r)throw Error('语音投递记录已移除');Object.assign(r,patch);receipt=structuredClone(r)})}
  await this.store.update(state=>{guard();const c=state.channels.find(c=>c.id===input.channelId)!;c.ttsReceipts=(c.ttsReceipts??[]).filter(r=>r.status!=='confirmed'||Date.now()-r.at<7*86400000);const old=c.ttsReceipts.find(r=>r.id===id);if(old){receipt=structuredClone(old);return}if(c.ttsReceipts.length>=500)throw Error('语音回执已满，请清理后再试');created=true;receipt={id,profileId:p?.id??'file',routeId:input.routeId,inputId:input.inputId,at:Date.now(),status:'generating',spokenText:input.text};c.ttsReceipts.push(receipt)})
  if(!created&&receipt!.status==='generating'){await update({status:'unknown'});return receipt!}
  if(receipt!.status==='confirmed'||receipt!.status==='unknown'||receipt!.status==='failed'||receipt!.status==='sending')return receipt!
  // A surviving generating receipt has no safe automatic retry (service may already have charged).
  let audio:Buffer
  if(receipt!.status==='generated'){
   if(!/^[a-f0-9]{64}\.(wav|mp3)$/.test(receipt!.audioId??''))throw Error('音频记录无效');audio=await readFile(join(this.directory,receipt!.audioId!));audioType(audio)
  }else{
   try{guard();const result=prepared??await this.generate(p!,input.text,voice,input.signal);audio=result.data;const audioId=id+(result.mediaType==='audio/wav'?'.wav':'.mp3');await mkdir(this.directory,{recursive:true,mode:0o700});await writeFile(join(this.directory,audioId),audio,{flag:'wx',mode:0o600});await update({status:'generated',audioId,mediaType:result.mediaType})}
   catch(e){await update({status:'unknown'});throw e}
  }
  guard();await update({status:'sending'})
  let dispatched=false
  try{guard();dispatched=true;const result=await input.send(audio!,AbortSignal.any([input.signal,AbortSignal.timeout(60000)]),guard,{path:join(this.directory,receipt!.audioId!),name:'语音'+(receipt!.mediaType==='audio/wav'?'.wav':'.mp3'),mediaType:receipt!.mediaType!,kind:'file'});if(typeof result==='string'?(!result||result==='0'):result?.confirmed!==true)throw Error('渠道未确认发送');const messageId=typeof result==='string'?result:result.messageId;await update({status:'confirmed',...(messageId?{messageId}:{})});return receipt!}
  catch(e){const rejected=!!(e as {sendRejected?:boolean})?.sendRejected;await update({status:dispatched&&!rejected?'unknown':'generated'});throw Error(rejected?'渠道拒绝发送；已保留音频，可重试发送而不重新合成':dispatched?'语音发送结果未确认，不自动重发，请核对当前会话':'当前对象或授权已变化，音频未发送')}
 }
}
