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
test('image-reference background task uses frozen references with no task-directory copy',async t=>{
 const {session,state,service,store,ctx,agent}=fixture(t)
 const id=add(session,'改这张图',[one]),imageReferences=service.plan(agent,route,id)
 const run={id:'work',ownerCompanionId:'c',sessionId:'child',status:'running',background:{sourceKind:'local',sourceSessionId:'source',routeId:'web',userId:route.userId,channelId:route.channelId,capabilities:[],imageReferences}}
 state.executionRuns.push(run)
 const child={session:{id:'child',header:{cwd:'/tmp/task'},snapshotEvents:()=>[]}}
 await assert.rejects(()=>service.resolve(child,[],signal()),/授权已失效/)
 const dispose=bindBackgroundScope(store,'child',{owner:'c',browserScope:'local',authorize(){}});t.after(dispose)
 add(session,'新消息与旧任务无关',[two])
 const resolved=await service.resolve(child,[],signal())
 assert.equal(resolved.uploads[0].source,imageReferenceId(one))
 assert.equal(ctx.agents.get('source'),agent)
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
