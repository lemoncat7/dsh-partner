import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {Session,appendPluginRecord} from '@deepseek-ai/dsh-session'
import {imageReferenceId,PartnerImageReferences,planImageReferences} from '../lib/attachments/image-references.js'
import {recordInputOrigin} from '../lib/conversation-history-recall.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
import {bindBackgroundScope} from '../lib/execution/background-scope.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'

const pic=(id,name)=>({attachmentId:'sha256:'+id,mediaType:'image/png',bytes:3,width:1,height:1,name})
const one=pic('1','猫图.png'),two=pic('2','狗图.png')
const route={id:'web',kind:'local',companionId:'c',channelId:'@local',userId:'owner:c',sessionId:'source'}
const options={privateFiles:true,shared:false,scope:'local'}
const signal=()=>new AbortController().signal
function add(session, words, images=[], origin) {
 const source={kind:'user'},content=[{type:'text',text:words},...images.map(attachment=>({type:'image',attachment}))]
 const message=createUserMessage({content,source})
 if(origin)recordInputOrigin(session,{messageId:message.id,...origin})
 session.append('user/message',message,{surfaceOp:'append'})
 return message.id
}
function fixture(t,cwd='/tmp'){
 const initial=Session.create('source')
 const session=Session.create('source',[],{...initial.header,cwd})
 const agent={session}
 const state={companions:[{id:'c',characterCard:{enabled:true},capabilities:[]}],sessions:[{...route,cwd}],channels:[],executionRuns:[]}
 const store={snapshot:()=>structuredClone(state)}
 const uploads=[]
 const ctx={agents:{get:id=>id==='source'?agent:undefined},attachments:{readImage:async ref=>{uploads.push(ref);return {ref,data:Buffer.from('abc')}},saveImage:async()=>one},logger:{warn:msg=>assert.fail(msg)}}
 const service=new PartnerImageReferences(ctx,store)
 return {session,agent,state,service,uploads,ctx,store}
}
test('image-reference history reuses an earlier image without a quote, ID, or re-upload',async t=>{
 const {session,agent,service,uploads}=fixture(t)
 add(session,'参考这张画猫', [one])
 const first=await service.resolve(agent,[],signal())
 assert.deepEqual(first.uploads.map(r=>r.source),[imageReferenceId(one)])
 first.confirm([])
 add(session,'继续把背景换成白色')
 const next=await service.resolve(agent,[],signal())
 assert.deepEqual(next.uploads.map(r=>r.source),[imageReferenceId(one)])
 assert.equal(uploads.length,2)
 assert.equal(imageReferenceId({...one,name:'重复上传的新名字.png'}),imageReferenceId(one))
 add(session,'画一张新的山水')
 assert.deepEqual((await service.resolve(agent,[],signal())).uploads,[])
 const archived=await service.resolve(agent,['/work/inbound/2026-11-19/'+imageReferenceId(one)+'.png'],signal())
 assert.equal(archived.uploads[0].source,imageReferenceId(one))
})
test('image-reference selection prefers actual latest upload or generated result in its conversation',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'partner-image-outputs-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const data=Buffer.from('generated'),path=join(cwd,'generated.png');await writeFile(path,data)
 const {session,service,agent}=fixture(t,cwd)
 add(session,'画一只小狗')
 const first=await service.resolve(agent,[],signal())
 first.confirm([{path,digest:createHash('sha256').update(data).digest('hex'),bytes:data.length,mediaType:'image/png'}])
 add(session,'改成黑白')
 const next=await service.resolve(agent,[],signal())
 assert.equal(next.uploads[0].source.startsWith('IMG-'),true)
 assert.deepEqual(next.uploads[0].data,data)
 add(session,'再发你一张图片',[two])
 add(session,'把刚才那张改成黑白')
 assert.equal((await service.resolve(agent,[],signal())).uploads[0].source,imageReferenceId(two))
})
test('image-reference plan never crosses sender, room, transport account or unknown scope',()=>{
 const session=Session.create('source')
 const member={...route,id:'group:a',kind:'channel',channelId:'qq',userId:'group:10000:20000'}
 const other={...member,id:'group:b',userId:'group:10000:30000'}
 const args={shared:true,privateFiles:false,scope:'account1'}
 add(session,'带私密内容',[one],{routeId:other.id,channelId:other.channelId,userId:other.userId,imageScope:'account1'})
 add(session,'旧账号',[one],{routeId:member.id,channelId:member.channelId,userId:member.userId,imageScope:'old-account'})
 const current=add(session,'使用 '+imageReferenceId(one),[],{routeId:member.id,channelId:member.channelId,userId:member.userId,imageScope:'account1',imageRequest:'使用 '+imageReferenceId(one)})
 const {plan,recent}=planImageReferences(session.snapshotEvents(),member,current,args)
 assert.ok(plan.issue);assert.deepEqual(recent,[])
 assert.ok(planImageReferences(session.snapshotEvents(),route,current,args).plan.issue)
})
test('image-reference private files require exact current authorization and never enter remembered images',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'partner-private-images-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 await mkdir(join(cwd,'照片'));await writeFile(join(cwd,'照片','私照.png'),'private bytes')
 const {session,agent,service}=fixture(t,cwd)
 add(session,'画我们两个人的婚纱照')
 await assert.rejects(()=>service.resolve(agent,['照片/私照.png'],signal()),/同一会话里的引用记录/)
 add(session,'本次允许使用私照：照片/私照.png\n画我们两个人的婚纱照')
 const approved=await service.resolve(agent,[],signal())
 assert.equal(approved.uploads[0].data.toString(),'private bytes');assert.equal(approved.confirm,undefined)
 add(session,'继续画')
 assert.deepEqual((await service.resolve(agent,[],signal())).uploads,[])
 await assert.rejects(()=>service.resolve(agent,['copy.png'],signal()),/同一会话里的引用记录/)
 add(session,'本次允许使用私照：../outside.png')
 await assert.rejects(()=>service.resolve(agent,[],signal()),/工作区内/)
})

test('autonomous drawing can use selected local character art without an attachment or opening other local photos',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'partner-drawing-reference-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const drawing='角色定稿.png',privatePhoto='私照.png'
 await writeFile(join(cwd,drawing),'character reference')
 await writeFile(join(cwd,privatePhoto),'private image')
 const {session,state,service,store,agent}=fixture(t,cwd)
 state.companions[0].characterCard.drawingReferences=[drawing]
 state.companions[0].idleContact={enabled:true}
 const notice=createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE},content:[{type:'text',text:'选择本轮活动'}]})
 session.append('user/message',notice,{surfaceOp:'append'})
 state.sessions[0].idleContactState={messageId:notice.id}
 const plan=references=>service.plan(agent,route,notice.id,{references,input:'用角色参考图绘图',signal:signal()})
 assert.match(service.context(agent),/角色定稿\.png/)
 await assert.rejects(()=>plan([privatePhoto]),/交接的参考图/)
 const handoff=await plan([join(cwd,drawing)])
 assert.equal(handoff.handedOff,true)
 assert.equal(handoff.selected[0].drawingPath,drawing)
 const run={id:'work',ownerCompanionId:'c',sessionId:'drawing-child',status:'running',background:{audience:'activity',sourceKind:'local',sourceSessionId:'source',sourceCwd:cwd,routeId:route.id,userId:route.userId,channelId:route.channelId,inputId:notice.id,capabilities:[],imageReferences:handoff}}
 state.executionRuns.push(run)
 const child={session:{id:run.sessionId,header:{cwd:'/tmp/task'},snapshotEvents:()=>[]}}
 t.after(bindBackgroundScope(store,run.sessionId,{owner:'c',audience:'activity',browserScope:'local',authorize(){}}))
 assert.equal((await service.resolve(child,[],signal())).uploads[0].data.toString(),'character reference')
 run.background.imageReferences=await plan(undefined)
 assert.deepEqual(run.background.imageReferences.drawingChoices,[drawing])
 assert.equal((await service.resolve(child,[drawing],signal())).uploads[0].data.toString(),'character reference')
 await assert.rejects(()=>service.resolve(child,[],signal()),/找不到指定的参考图/)
 state.companions[0].characterCard.drawingReferences=[]
 await assert.rejects(()=>service.resolve(child,[drawing],signal()),/配置已变化/)
})
test('image-reference background task uses frozen references with no task-directory copy',async t=>{
 const {session,state,service,store,ctx,agent}=fixture(t)
 add(session,'稍后用这张',[two])
 const id=add(session,'改这张图',[one]),imageReferences=await service.plan(agent,route,id)
 const run={id:'work',ownerCompanionId:'c',sessionId:'child',status:'running',background:{sourceKind:'local',sourceSessionId:'source',routeId:'web',userId:route.userId,channelId:route.channelId,inputId:id,capabilities:[],imageReferences}}
 state.executionRuns.push(run)
 const child={session:{id:'child',header:{cwd:'/tmp/task'},snapshotEvents:()=>[]}}
 await assert.rejects(()=>service.resolve(child,[],signal()),/授权已失效/)
 const dispose=bindBackgroundScope(store,'child',{owner:'c',browserScope:'local',authorize(){}});t.after(dispose)
 const later=pic('3','后来的图.png');add(session,'新消息与旧任务无关',[later])
 const resolved=await service.resolve(child,[],signal())
 assert.equal(resolved.uploads[0].source,imageReferenceId(one))
 assert.equal((await service.resolve(child,[imageReferenceId(two)],signal())).uploads[0].source,imageReferenceId(two))
 await assert.rejects(()=>service.resolve(child,[imageReferenceId(later)],signal()),/同一会话里的引用记录/)
 assert.equal(ctx.agents.get('source'),agent)
})

test('background uses the ordered foreground handoff even when the current message carries another image',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'partner-image-handoff-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const {session,state,service,store,ctx,agent}=fixture(t,cwd)
 const sourceBytes=Buffer.from('abc'),earlier=pic(createHash('sha256').update(sourceBytes).digest('hex'),'原图.png')
 const archived=join(cwd,'stored-image.png');await writeFile(archived,sourceBytes)
 const unknown=join(cwd,'other-image.png');await writeFile(unknown,'xyz')
 add(session,'这两张是原图',[earlier,one])
 const inputId=add(session,'用先前的两张做配图',[two])
 const handoff=references=>service.plan(agent,route,inputId,{references,input:'做配图',signal:signal()})
 await assert.rejects(()=>handoff([unknown]),/前台交接的参考图在原会话中找不到/)
 const imageReferences=await handoff([imageReferenceId(one),archived])
 assert.deepEqual(imageReferences.selected.map(r=>r.id),[imageReferenceId(one),imageReferenceId(earlier)])
 const implicit=await service.plan(agent,route,inputId,{input:'参考 '+imageReferenceId(earlier),references:undefined,signal:signal()})
 assert.equal(implicit.selected[0].id,imageReferenceId(earlier))
 state.executionRuns.push({id:'work',ownerCompanionId:'c',sessionId:'child',status:'running',background:{sourceKind:'local',sourceSessionId:'source',routeId:'web',userId:route.userId,channelId:route.channelId,inputId,capabilities:[],imageReferences}})
 const child={session:{id:'child',header:{cwd:'/tmp/task'}}}
 const dispose=bindBackgroundScope(store,'child',{owner:'c',browserScope:'local',authorize(){}});t.after(dispose)
 ctx.agents.get=()=>undefined
 for(const requested of [[],[imageReferenceId(two)]]){
  const resolved=await service.resolve(child,requested,signal())
  assert.deepEqual(resolved.uploads.map(r=>r.source),[imageReferenceId(one),imageReferenceId(earlier)])
 }
 const exact=add(session,'只用 '+imageReferenceId(one),[two])
 const exactPlan=await service.plan(agent,route,exact,{references:[imageReferenceId(two)],input:'做配图',signal:signal()})
 assert.deepEqual(exactPlan.selected.map(i=>i.id),[imageReferenceId(one)])
 const noReference=add(session,'这次纯文字生图',[two])
 const textOnly=await service.plan(agent,route,noReference,{references:[imageReferenceId(two)],input:'做配图',signal:signal()})
 assert.deepEqual(textOnly.selected,[])
})

test('foreground can hand off a received public room image but never another room or private chat image',async t=>{
 const {session,state,service,agent,ctx,store}=fixture(t)
 const first={...route,id:'member-a',kind:'channel',channelId:'qq',userId:'group:1129721318:22334455'}
 const second={...first,id:'member-b',userId:'group:1129721318:33445566'}
 const outside={...first,id:'elsewhere',userId:'group:99887766:22334455'}
 const channel={id:'qq',platform:'qq',enabled:true,accountId:'55667788',companionId:'c',qq:{groupReplies:true,groupIds:['1129721318'],autonomousGroupIds:['1129721318']}}
 state.channels=[channel];state.pairings=[];state.sessions=[first,second,outside]
 const origin=(r,extra)=>({routeId:r.id,channelId:r.channelId,userId:r.userId,imageScope:'["55667788","",""]',...extra})
 const imageMessageId='qq:55667788:'+second.userId+':-1004'
 add(session,'发给群里的图',[one],origin(second,{imageSources:[{messageId:imageMessageId,image:one}]}))
 add(session,'另一个群的图',[two],origin(outside))
 const inputId=add(session,'用群里那张图',[],origin(first,{imageRequest:'用群里那张图'}))
 const handoff=references=>service.plan(agent,first,inputId,{references,input:'做配图',signal:signal()})
 assert.deepEqual((await handoff([imageReferenceId(one)])).selected.map(i=>i.id),[imageReferenceId(one)])
 await assert.rejects(()=>handoff([imageReferenceId(two)]),/原会话中找不到/)
 const cached=await PartnerAgentRuntime.prototype.quotedImages.call({ctx,store,handles:new Map()},'c','qq',second.userId,'-1004')
 assert.equal(cached[0].image.attachmentId,one.attachmentId)
})
test('image-reference archive reuses only today and works after the old dated folder is cleared',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'partner-saved-images-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const time=Date.parse('2026-11-18T16:01:00Z')
 t.mock.timers.enable({apis:['Date'],now:time})
 const {ctx}=fixture(t,cwd),incoming={text:'看这个',attachments:[{kind:'image',name:'猫图.png',data:Buffer.from('abc'),mediaType:'image/png',referenceMessageId:'8'}]}
 const a=await PartnerAgentRuntime.prototype.persistInbound.call({ctx,defaultCwd:cwd},route,incoming)
 const b=await PartnerAgentRuntime.prototype.persistInbound.call({ctx,defaultCwd:cwd},route,{...incoming,text:'重发'})

 assert.match(a.content[0].text,new RegExp(imageReferenceId(one)))
 assert.match(b.content[0].text,new RegExp(imageReferenceId(one)))
 const filename=imageReferenceId(one)+'.png'
 for(const item of [a,b])assert.ok(item.content[0].text.includes('inbound/2026-11-19/'+filename))
 assert.deepEqual(await readdir(join(cwd,'inbound')),['2026-11-19'])
 assert.deepEqual(await readdir(join(cwd,'inbound','2026-11-19')),[filename])
 assert.equal(await readFile(join(cwd,'inbound','2026-11-19',filename),'utf8'),'abc')
 assert.deepEqual(a.images.imageSources,b.images.imageSources)
 await rm(join(cwd,'inbound','2026-11-19'),{recursive:true})
 t.mock.timers.setTime(time+86400000)
 const c=await PartnerAgentRuntime.prototype.persistInbound.call({ctx,defaultCwd:cwd},route,{text:'引用原图',attachments:[],storedImages:a.images.imageSources})
 assert.ok(c.content[0].text.includes('inbound/2026-11-20/'+filename))
 assert.deepEqual(await readdir(join(cwd,'inbound')),['2026-11-20'])
 assert.deepEqual(a.images.imageSources,c.images.imageSources)
})

test('published legacy image tool reads verified temporary references and removes staging after execution',async t=>{
 const {legacyImageTool}=await import('../lib/attachments/legacy-image-tool.js')
 const root=await mkdtemp(join(tmpdir(),'partner-legacy-image-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const {session,agent,service}=fixture(t,root)
 let called=0,tempPath
 const old={name:'generate_image',description:'Generate or edit images using the configured OpenAI-compatible image service.',execute:async args=>{
   called++;assert.equal(args.prompt,'改图')
   assert.equal(args.referenceImages.length,1)
   tempPath=args.referenceImages[0];assert.ok(tempPath.startsWith(root+'/.partner-image-input-'))
   assert.equal(await readFile(tempPath,'utf8'),'abc')
   return JSON.stringify({files:[]})
 }}
 const tool=legacyImageTool(old,service)
 add(session,'用这个图',[one])
 await assert.rejects(()=>tool.execute({prompt:'改图',referenceImages:['/private/photo.png']},{agent,signal:signal()}),/同一会话里的引用记录/)
 assert.equal(called,0)
 await tool.execute({prompt:'改图',referenceImages:[imageReferenceId(one)]},{agent,signal:signal()})
 assert.equal(called,1)
 assert.deepEqual(await readdir(root),[])
 assert.equal(legacyImageTool({...old,description:old.description+' partner reference authorization is verified'},service),undefined)
})
