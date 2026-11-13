import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {publicArtifactPath} from '../lib/attachments/public-delivery.js'
import {attachmentTool} from '../lib/attachments/tool.js'
import {AttachmentDeliveryService} from '../lib/attachments/service.js'
import {OneBotTransport} from '../lib/channels/qq/transport.js'
import {qqSettings} from '../lib/channels/qq/settings.js'
import {qqToolAccessAdapter} from '../lib/channels/qq/authority.js'
const user=id=>({seq:1,type:'user/message',data:{id,source:{kind:'user'}}})
const call={seq:2,type:'tool/call',data:{name:'generate_image',callId:'gen',arguments:'{}'}}
const result=path=>({seq:3,type:'tool/result',data:{message:{toolCallId:'gen',isError:false,content:[{type:'text',text:JSON.stringify({files:[{path}]})}]}}})
const route={id:'r',kind:'channel',sessionId:'s',companionId:'c',channelId:'q',userId:'group:11223344:22334455',inboundMessageIds:['input']}
test('public artifact proofs use successful tool outputs and originating room, never user text or read metadata',()=>{
 const events=[user('input'),call,result('/work/image.png')]
 assert.equal(publicArtifactPath('image.png','/work',events,[route],route),true)
 assert.equal(publicArtifactPath('secret.md','/work',events,[route],route),false)
 assert.equal(publicArtifactPath('image.png','/work',[user('unbound'),call,result('/work/image.png')],[route],route),false)
 assert.equal(publicArtifactPath('image.png','/work',[events[0],call,{...events[2],data:{message:{...events[2].data.message,isError:true}}}],[route],route),false)
 const other={...route,id:'other',userId:'group:99887766:22334455',inboundMessageIds:['other']}
 assert.equal(publicArtifactPath('image.png','/work',[user('other'),call,result('/work/image.png')],[route,other],route),false)
 const member={...route,id:'member',userId:'group:11223344:55667788',inboundMessageIds:['member']}
 assert.equal(publicArtifactPath('image.png','/work',[user('member'),call,result('/work/image.png')],[route,member],route),true)
 const metadata={seq:3,type:'tool/result',data:{meta:{path:'/work/secret.md'},message:{toolCallId:'gen',content:[{type:'text',text:'private contents'}]}}}
 assert.equal(publicArtifactPath('secret.md','/work',[events[0],call,metadata],[route],route),false)
 const ptc={seq:3,type:'tool/ptc-dispatch',data:{rootCallId:'gen',isError:false,content:result('/work/image.png').data.message.content}}
 assert.equal(publicArtifactPath('image.png','/work',[events[0],call,ptc],[route],route),true)
})

test('unbound group member can deliver generated image through current OneBot account, retry safely, but not export unrelated files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'partner-public-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const cwd=join(root,'workspace');await mkdir(cwd)
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pXkAAAAASUVORK5CYII=','base64')
 await writeFile(join(cwd,'image.png'),png);await writeFile(join(cwd,'secret.md'),'private')
 const service=await AttachmentDeliveryService.open(join(root,'deliveries'));t.after(()=>service.close())
 const channel={id:'q',platform:'qq',enabled:true,accountId:'12345678',companionId:'c',qq:qqSettings({groupReplies:true,groupIds:['11223344'],identityBinding:{enabled:true,qqIds:['99887766']}})}
 const state={companions:[{id:'c'}],sessions:[{...route,cwd}],channels:[channel]}
 const events=[user('input'),call,result(join(cwd,'image.png'))],agent={session:{id:'s',header:{cwd},seq:4,snapshotEvents:()=>events}}
 assert.ok(qqToolAccessAdapter.resolve({agent,state}).allowedTools.includes('partner_send_attachment'))
 const sends=[];let fail=true
 const connection={call:async(name,args)=>{
  if(name==='get_login_info')return {user_id:12345678}
  if(name==='get_status')return {online:true,good:true}
  if(name==='get_group_list')return [{group_id:11223344}]
  if(name==='get_group_member_info')return {group_id:11223344,user_id:22334455}
  assert.equal(name,'send_group_msg');assert.equal(args.group_id,11223344);assert.equal(args.message[0].type,'image');assert.equal(args.message[0].data.file,'base64://'+png.toString('base64'));sends.push(args)
  if(fail)throw Error('simulated upload rejection')
  return {message_id:123}
 }}
 const transport=new OneBotTransport({platform:'qq',baseUrl:'ws://unused',targetId:'group:11223344',qq:channel.qq},'',{accountId:'12345678',peerId:route.userId},connection)
 const signal=new AbortController().signal
 const tool=attachmentTool('c',{snapshot:()=>state,isCompanionRemoving:()=>false},service,{attachments:{saveImage:async()=>({attachmentId:'image',mediaType:'image/png'})}},{sendExplicitAttachment:async(_s,file)=>transport.sendAttachment(route.userId,file,signal,()=>true)},'/api')
 const exec={agent,signal,deferContext:()=>{}}
 await assert.rejects(tool.execute({path:'secret.md'},exec),/仅允许当前会话/)
 await assert.rejects(tool.execute({workReport:{name:'secret.md',runIds:['run']}},exec),/不导出私有工作记录/)
 const first=JSON.parse(await tool.execute({path:'image.png'},exec));assert.equal(first.channel,'failed');assert.ok(first.retry.deliveryId)
 fail=false;await rm(join(cwd,'image.png'))
 assert.equal(JSON.parse(await tool.execute({deliveryId:first.deliveryId},exec)).channel,'sent')
 await tool.execute({deliveryId:first.deliveryId},exec);assert.equal(sends.length,2)
})
