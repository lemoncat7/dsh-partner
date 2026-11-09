import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ttsProfile} from '../lib/voice/domain.js'
import {ttsRequest,synthesize,audioType} from '../lib/voice/synthesize.js'
import {TtsService} from '../lib/voice/service.js'
import {voiceReplyTool} from '../lib/voice/tool.js'
import {qqReplyTool} from '../lib/channels/qq/reply-tool.js'
const raw={name:'测试服务',provider:'breezeblue',endpoint:'https://api.breeze.blue',voice:'voice/a',model:'breeze-tts-2',language:'zh',speed:1.05,format:'wav',instructions:'轻松地说'}
function wav(){const b=Buffer.alloc(244);b.write('RIFF');b.writeUInt32LE(236,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(200,40);return b}
const response=()=>new Response(wav(),{headers:{'content-type':'audio/wav'}})
function fixture(fetcher=async()=>response()){
 const state={companions:[{id:'c'}],channels:[{id:'ch',companionId:'c',platform:'qq',enabled:true,updatedAt:1,qq:{privateReplies:true,replyVoiceEnabled:false}}],sessions:[{id:'r',kind:'channel',sessionId:'s',companionId:'c',channelId:'ch',userId:'12345678',inboundMessageIds:['u']}],pairings:[{channelId:'ch',userId:'12345678',status:'approved'}]}
 const keys=new Map(),store={snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)},vault={write:async(id,key)=>{keys.set(id,key)},read:async id=>keys.get(id),delete:async id=>keys.delete(id)}
 return {state,store,vault,keys,fetcher}
}
async function setup(t,fetcher){const f=fixture(fetcher);f.dir=await mkdtemp(join(tmpdir(),'partner-tts-'));t.after(()=>rm(f.dir,{recursive:true,force:true}));f.service=new TtsService(f.store,f.vault,f.dir,f.fetcher);f.profile=await f.service.save('c',{...raw,apiKey:'test-secret'});await f.service.configure('ch',{enabled:true,profileId:f.profile.id,voice:'',expectedUpdatedAt:1});return f}
function delivery(f,extra={}){return {owner:'c',channelId:'ch',routeId:'r',inputId:'u',text:'你好',signal:new AbortController().signal,guard:()=>{},send:async()=>'-123',...extra}}
test('BreezeBlue uses encoded voice path, query format and xi-api-key; binary is validated',async()=>{
 const p=ttsProfile(raw,'p',1);let request
 const out=await synthesize(p,'secret','你好','voice/a',new AbortController().signal,async(url,init)=>{request={url,...init};return response()})
 assert.match(request.url,/voice%2Fa\?output_format=wav&delivery=sync$/);assert.equal(request.headers['xi-api-key'],'secret');assert.equal(request.redirect,'error');assert.equal(JSON.parse(request.body).model_id,'breeze-tts-2');assert.equal(out.mediaType,'audio/wav')
})
test('OpenAI-compatible speech preserves text, voice, speed and optional instructions',()=>{
 const p=ttsProfile({...raw,provider:'openai',endpoint:'https://example.test/v1'},'p',1)
 const r=ttsRequest(p,'quote " newline\ntext');assert.equal(r.url,'https://example.test/v1/audio/speech');assert.equal(r.body.input,'quote " newline\ntext');assert.equal(r.body.speed,1.05);assert.equal(p.authPrefix,'Bearer ')
})
test('HTTP template substitutes values structurally and decodes nested Base64',async()=>{
 const p=ttsProfile({...raw,provider:'http',endpoint:'https://example.test/tts',bodyTemplate:'{"input":"{{text}}","speed":"{{speed}}"}',responseMode:'base64',responsePath:'data.audio'},'p',1)
 const text='"},"inject":true,"x":"';assert.equal(ttsRequest(p,text).body.input,text);assert.equal(ttsRequest(p,text).body.speed,1.05)
 const result=await synthesize(p,'',text,p.voice,new AbortController().signal,async()=>new Response(JSON.stringify({data:{audio:wav().toString('base64')}})))
 assert.equal(result.mediaType,'audio/wav')
})
for(const mode of ['json','wrong-header','truncated','oversize','http','timeout'])test('rejects invalid audio or uncertain response: '+mode,async()=>{
 const p=ttsProfile(raw,'p',1)
 await assert.rejects(synthesize(p,'secret','hello',p.voice,new AbortController().signal,async()=>{
  if(mode==='timeout')throw Error('secret');if(mode==='http')return new Response('secret',{status:500});if(mode==='oversize')return new Response(wav(),{headers:{'content-length':'999999999'}})
  if(mode==='json')return new Response('{"error":"bad"}',{headers:{'content-type':'audio/wav'}})
  if(mode==='wrong-header')return new Response(wav(),{headers:{'content-type':'text/html'}})
  return new Response(wav().subarray(0,50),{headers:{'content-type':'audio/wav'}})
 }),e=>!e.message.includes('secret'))
})
test('profile keys stay in credential vault and changing endpoints requires fresh key',async t=>{
 const f=await setup(t);assert.equal(f.profile.credentialConfigured,true);assert.doesNotMatch(JSON.stringify(f.state),/test-secret/);assert.equal(f.profile.credentialId,undefined)
 await assert.rejects(f.service.save('c',{...f.profile,endpoint:'https://other.test',expectedUpdatedAt:f.profile.updatedAt}),/重新填写/)
 await assert.rejects(f.service.save('c',{...f.profile,expectedUpdatedAt:0}),/变化/)
 await assert.rejects(f.service.remove('c',f.profile.id,f.profile.updatedAt),/引用/)
})
test('confirmed same-input retries do not regenerate or resend, concurrent calls coalesce',async t=>{
 let generation=0,sends=0;const f=await setup(t,async()=>{generation++;await new Promise(r=>setTimeout(r,10));return response()});const input=delivery(f,{send:async()=>{sends++;return '123'}})
 const out=await Promise.all([f.service.deliver(input),f.service.deliver(input)]);await f.service.deliver(input)
 assert.equal(out[0].status,'confirmed');assert.equal(generation,1);assert.equal(sends,1)
})
test('known send rejection reuses persisted audio after restart without regeneration',async t=>{
 let generations=0;const f=await setup(t,async()=>{generations++;return response()})
 await assert.rejects(f.service.deliver(delivery(f,{send:async()=>{throw Object.assign(Error('rejected'),{sendRejected:true})}})),/已保留音频/)
 assert.equal(f.state.channels[0].ttsReceipts[0].status,'generated')
 const restored=new TtsService(f.store,f.vault,f.dir,f.fetcher);await restored.recover()
 assert.equal((await restored.deliver(delivery(f))).status,'confirmed');assert.equal(generations,1)
})
test('unknown send result and interrupted generation never auto-retry',async t=>{
 let generations=0,sends=0;const f=await setup(t,async()=>{generations++;return response()})
 const input=delivery(f,{send:async()=>{sends++;throw Error('timeout')}});await assert.rejects(f.service.deliver(input),/未确认/)
 assert.equal((await f.service.deliver(input)).status,'unknown');assert.equal(generations,1);assert.equal(sends,1)
 f.state.channels[0].ttsReceipts[0].status='generating';await f.service.recover();assert.equal(f.state.channels[0].ttsReceipts[0].status,'unknown')
})
test('revocation after synthesis prevents sending but retains generated audio',async t=>{
 let allowed=true,sends=0;const f=await setup(t,async()=>{allowed=false;return response()})
 await assert.rejects(f.service.deliver(delivery(f,{guard:()=>{if(!allowed)throw Error('revoked')},send:async()=>{sends++;return 'x'}})),/revoked/)
 assert.equal(sends,0);assert.equal(f.state.channels[0].ttsReceipts[0].status,'generated')
})
function execFixture(f){let concluded=0;const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'说句话'}]}}];return {events,exec:{agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal,callId:'call',concludeTurn:()=>{concluded++}},concluded:()=>concluded}}
test('public current-chat tool sends real QQ record and marks spoken completion without private/native switch',async t=>{
 const f=await setup(t),x=execFixture(f);let sent
 const tool=voiceReplyTool('c',f.store,f.service,async(_id,action,params)=>{sent={action,params};return {message_id:123}})
 const out=await tool.execute({action:'speak',text:'你好'},x.exec)
 assert.equal(sent.action,'send_private_msg');assert.equal(sent.params.user_id,12345678);assert.match(sent.params.message[0].data.file,/^base64:\/\//);assert.equal(x.concluded(),1)
 const meta=tool.output.presentationMeta({},out);assert.equal(meta.delivered,true);assert.equal(meta.spokenText,'你好');assert.deepEqual(meta.parts,[])
})
test('continueTurn preserves intermediate receipt and old QQ voice tool uses external selection',async t=>{
 const f=await setup(t),x=execFixture(f),tool=voiceReplyTool('c',f.store,f.service,async()=>({message_id:123}))
 const out=await tool.execute({action:'speak',text:'你好',continueTurn:true},x.exec);assert.equal(x.concluded(),0);assert.equal(tool.output.presentationMeta({},out).intermediate,true)
 const native=qqReplyTool('c',f.store,async()=>{throw Error('native must not run')},tool)
 const status=await native.execute({action:'voices'},x.exec);assert.equal(status.provider,'breezeblue')
})
test('new input while generating cancels old audience delivery',async t=>{
 let x,sends=0;const f=await setup(t,async()=>{x.events.push({seq:3,type:'user/message',data:{id:'new',source:{kind:'user'},content:[]}});return response()});x=execFixture(f)
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{sends++;return {message_id:123}})
 await assert.rejects(tool.execute({action:'speak',text:'旧回复'},x.exec),/变化/);assert.equal(sends,0);assert.equal(x.concluded(),0)
})

test('voice receipt is a completed reply, never the empty-reply fallback',async t=>{
 const {channelReplyPartsAfter}=await import('../lib/channels/delivery-policy.js')
 const {prepareChannelReply}=await import('../lib/channels/outbound-media.js')
 const f=await setup(t),x=execFixture(f),tool=voiceReplyTool('c',f.store,f.service,async()=>({message_id:88}))
 const args={action:'speak',text:'声音已发送'},out=await tool.execute(args,x.exec)
 x.events.push({seq:3,type:'tool/call',data:{callId:'call',name:'partner_voice_reply',arguments:JSON.stringify(args)}},{seq:4,type:'tool/result',data:{message:{toolCallId:'call',content:[],isError:false},meta:tool.output.presentationMeta(args,out)}},{seq:5,type:'turn/end',data:{reason:{kind:'completed'}}})
 const reply=await prepareChannelReply(channelReplyPartsAfter(x.events,0),'/tmp',true)
 assert.equal(reply.text,'');assert.equal(reply.alreadyDelivered,true);assert.deepEqual(reply.chatParts,[])
})
test('TTS profiles and receipts survive private state splitting without publishing keys',async t=>{
 const {PartnerStore}=await import('../lib/store.js')
 const root=await mkdtemp(join(tmpdir(),'partner-tts-persist-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=await PartnerStore.open(join(root,'state.json'))
 const owner=store.snapshot().companions[0].id,keys=new Map(),vault={write:async(id,key)=>keys.set(id,key),read:async id=>keys.get(id),delete:async id=>keys.delete(id)}
 const service=new TtsService(store,vault,join(root,'audio'))
 const profile=await service.save(owner,{...raw,apiKey:'do-not-store-in-state'})
 const reopened=await PartnerStore.open(join(root,'state.json'))
 assert.equal(reopened.snapshot().companions[0].ttsProfiles[0].id,profile.id)
 assert.doesNotMatch(JSON.stringify(reopened.snapshot()),/do-not-store-in-state/)
})

for(const platform of ['weixin','matrix','mattermost'])test('shared TTS sends current-channel audio and deduplicates acknowledged delivery: '+platform,async t=>{
 let generated=0,sends=0;const f=await setup(t,async()=>{generated++;return response()}),x=execFixture(f),c=f.state.channels[0]
 c.platform=platform;c.direct=platform==='weixin'?undefined:{targetId:'room',baseUrl:'https://chat.test'}
 f.state.pairings[0].directTargetId=platform==='weixin'?'':'room'
 await f.service.configure(c.id,{enabled:true,profileId:f.profile.id,voice:'',expectedUpdatedAt:c.updatedAt})
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{throw Error('QQ should not run')},async(session,file,signal,route,guard)=>{
  guard();sends++;assert.equal(session,'s');assert.equal(route,'r');assert.equal(file.mediaType,'audio/wav');assert.equal(file.name,'语音.wav');assert.ok(file.path.startsWith(f.dir));assert.equal(signal.aborted,false)
 })
 assert.equal((await tool.execute({action:'status'},x.exec)).delivery,'audio-attachment')
 const out=await tool.execute({action:'speak',text:'你好'},x.exec)
 await tool.execute({action:'speak',text:'你好'},x.exec)
 assert.equal(out.status,'confirmed');assert.equal(out.messageId,undefined);assert.equal(sends,1);assert.equal(generated,1)
 assert.equal(tool.output.presentationMeta({},out).delivered,true)
})

test('non-chat channel cannot be configured or incur TTS charges',async t=>{
 let generated=0;const f=await setup(t,async()=>{generated++;return response()}),x=execFixture(f)
 f.state.channels[0].platform='bilibili'
 await assert.rejects(f.service.configure('ch',{enabled:true,profileId:f.profile.id,voice:'',expectedUpdatedAt:f.state.channels[0].updatedAt}),/不支持/)
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{})
 await assert.rejects(tool.execute({action:'speak',text:'你好'},x.exec),/不是支持/);assert.equal(generated,0)
})

for(const change of ['permission','destination','new-input'])test('cross-channel TTS rechecks audience during synthesis: '+change,async t=>{
 let f,x,sends=0;f=await setup(t,async()=>{
  if(change==='permission')f.state.pairings[0].status='blocked'
  if(change==='destination')f.state.channels[0].direct.targetId='another-room'
  if(change==='new-input')x.events.push({seq:3,type:'user/message',data:{id:'next',source:{kind:'user'},content:[]}})
  return response()
 });x=execFixture(f);f.state.channels[0].platform='matrix';f.state.channels[0].direct={targetId:'room'}
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{},async()=>{sends++})
 await assert.rejects(tool.execute({action:'speak',text:'旧回复'},x.exec),/变化|撤回/);assert.equal(sends,0);assert.equal(x.concluded(),0)
})

test('failed audio attachment never confirms speech or automatically sends it again',async t=>{
 const f=await setup(t),x=execFixture(f);f.state.channels[0].platform='weixin';let sends=0
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{},async()=>{sends++;throw Error('upload succeeded, final send timed out')})
 await assert.rejects(tool.execute({action:'speak',text:'你好'},x.exec),/未确认/)
 await assert.rejects(tool.execute({action:'speak',text:'你好'},x.exec),/未知/)
 assert.equal(sends,1);assert.equal(x.concluded(),0);assert.equal(f.state.channels[0].ttsReceipts[0].status,'unknown')
})

for(const revokedAt of ['before-upload','after-upload'])test('WeChat audio attachment guards before sending: '+revokedAt,async t=>{
 const {WeixinApi}=await import('../lib/channels/weixin/api.js')
 const {writeFile}=await import('node:fs/promises')
 const f=await setup(t),path=join(f.dir,'preview.wav');await writeFile(path,wav())
 let allowed=revokedAt!=='before-upload',sends=0,uploads=0
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original})
 globalThis.fetch=async(url)=>{
  const value=String(url)
  if(value.endsWith('getuploadurl')){uploads++;return Response.json({ret:0,upload_full_url:'https://novac2c.cdn.weixin.qq.com/c2c/upload'})}
  if(value.includes('/c2c/upload')){allowed=false;return new Response('',{headers:{'x-encrypted-param':'audio-ref'}})}
  if(value.endsWith('sendmessage')){sends++;return Response.json({ret:0})}
  throw Error('unexpected fetch')
 }
 await assert.rejects(new WeixinApi().sendAttachment('peer',{path,name:'语音.wav',mediaType:'audio/wav',kind:'file'},'context',new AbortController().signal,()=>allowed),/撤销/)
 assert.equal(sends,0);assert.equal(uploads,revokedAt==='before-upload'?0:1)
})

async function fileVoiceFixture(t){
 const {writeFile}=await import('node:fs/promises');const f=await setup(t,async()=>{throw Error('file playback must never synthesize')});
 f.state.channels[0].tts={enabled:false,profileId:'',voice:''};f.state.companions[0].ttsProfiles=[];f.state.sessions[0].cwd=f.dir
 f.path=join(f.dir,'audition.wav');await writeFile(f.path,wav());return f
}
test('script-generated audio is sent unchanged without TTS profiles or native voice enablement',async t=>{
 const f=await fileVoiceFixture(t),x=execFixture(f);let sends=0
 const tool=voiceReplyTool('c',f.store,f.service,async(_id,action,args)=>{sends++;assert.equal(action,'send_private_msg');assert.equal(args.message[0].data.file,'base64://'+wav().toString('base64'));return {message_id:'file-voice'}})
 assert.equal((await tool.execute({action:'status'},x.exec)).sendFile,true)
 const out=await tool.execute({action:'send_file',path:f.path,continueTurn:true},x.exec)
 await tool.execute({action:'send_file',path:f.path,continueTurn:true},x.exec)
 assert.equal(out.status,'confirmed');assert.equal(sends,1);assert.equal(x.concluded(),0);assert.equal(tool.output.presentationMeta({},out).intermediate,true)
})
test('different script audio candidates can be auditioned within one turn',async t=>{
 const {writeFile}=await import('node:fs/promises');const f=await fileVoiceFixture(t),x=execFixture(f);let sends=0
 const tool=voiceReplyTool('c',f.store,f.service,async()=>({message_id:++sends}))
 await tool.execute({action:'send_file',path:f.path,continueTurn:true},x.exec)
 const second=wav();second[80]=42;await writeFile(join(f.dir,'candidate-b.wav'),second)
 await tool.execute({action:'send_file',path:join(f.dir,'candidate-b.wav')},x.exec)
 assert.equal(sends,2);assert.equal(x.concluded(),1)
})
test('file send rejects URLs, workspace escapes, invalid audio and synthesis parameters',async t=>{
 const {writeFile,symlink}=await import('node:fs/promises');const f=await fileVoiceFixture(t),x=execFixture(f);let sends=0
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{sends++;return {message_id:1}})
 const outside=await mkdtemp(join(tmpdir(),'other-voice-'));t.after(()=>rm(outside,{recursive:true,force:true}));await writeFile(join(outside,'voice.wav'),wav());await symlink(join(outside,'voice.wav'),join(f.dir,'escape.wav'));await writeFile(join(f.dir,'bad.wav'),'not audio')
 for(const path of ['https://example.test/a.wav',join(outside,'voice.wav'),join(f.dir,'escape.wav'),join(f.dir,'bad.wav')])await assert.rejects(tool.execute({action:'send_file',path},x.exec))
 await assert.rejects(tool.execute({action:'send_file',path:f.path,voice:'other'},x.exec),/只需/)
 assert.equal(sends,0)
})
test('file send uses generic audio transport without invoking synthesis and never retries uncertain delivery',async t=>{
 const f=await fileVoiceFixture(t),x=execFixture(f);f.state.channels[0].platform='weixin';let sends=0
 const tool=voiceReplyTool('c',f.store,f.service,async()=>{throw Error('QQ must not run')},async()=>{sends++;throw Error('timeout')})
 await assert.rejects(tool.execute({action:'send_file',path:f.path},x.exec),/未确认/)
 await assert.rejects(tool.execute({action:'send_file',path:f.path},x.exec),/未知/)
 assert.equal(sends,1);assert.equal(x.concluded(),0)
})
