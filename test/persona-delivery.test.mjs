import test from 'node:test'
import assert from 'node:assert/strict'
import {renderPersonaDelivery} from '../lib/chat/persona-delivery.js'
import {bilibiliTool} from '../lib/channels/bilibili/tools.js'
import {BilibiliService} from '../lib/channels/bilibili/service.js'
function fixture(){
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'PRIVATE CHAT MESSAGE'}]}},{seq:3,type:'request/header',data:{header:{config:{provider:'same',model:'same-model'}}}}]
 const c={id:'c',name:'伙伴',role:'角色',description:'描述',instructions:'人物习惯',capabilities:['skills'],characterCard:{enabled:true,roleText:'当前可编辑的人格',segmentedReplies:true,length:'short'},relationshipText:'PRIVATE RELATIONSHIP'}
 const state={companions:[c],channels:[],pairings:[],sessions:[{id:'route',kind:'local',sessionId:'s',companionId:'c'}]}
 const store={snapshot:()=>state,isCompanionRemoving:()=>false,update:async fn=>fn(state)},controller=new AbortController()
 const exec={agent:{session:{id:'s',header:{cwd:'/tmp'},snapshotEvents:()=>events}},signal:controller.signal}
 let count=0,request,response=()=>({texts:['人物的回应']})
 const ctx={llm:{async *stream(req){count++;request=req;const v=await response(req);yield {type:'block-end',block:{type:'tool-call',name:'render_persona_text',arguments:JSON.stringify(v)}};yield {type:'finish',reason:{kind:'tool-calls'}}}}}
 return {c,state,store,events,exec,ctx,controller,respond:fn=>response=fn,count:()=>count,request:()=>request,run:(parts=[{text:'原始草稿'}],options={})=>renderPersonaDelivery(ctx,'c',store,exec,parts,options)}
}
test('ordinary chat preserves authored wording without a second model request',async()=>{
 const f=fixture(),before=JSON.stringify([f.events,f.state]);const r=await f.run()
 assert.equal(r.audit.status,'preserved');assert.equal(r.parts[0].text,'原始草稿');assert.equal(f.count(),0)
 assert.equal(JSON.stringify([f.events,f.state]),before);assert.deepEqual((await f.run()).parts,r.parts)
})
test('public composition omits private relation and dialogue, targets the real comment thread',async()=>{
 const f=fixture();await f.run([{text:'条件和结果能对调吗？'}],{surface:'public-comment',target:'video:root:parent',single:true})
 const request=JSON.stringify(f.request());assert.doesNotMatch(request,/PRIVATE RELATIONSHIP|PRIVATE CHAT MESSAGE/);assert.match(request,/video:root:parent/);assert.match(request,/公开评论/)
})
for(const change of ['input','persona','sleep','route','cancel'])test('changed '+change+' stops old wording without original-draft fallback',async()=>{
 const f=fixture();f.respond(()=>{if(change==='input')f.events.push({...f.events[1],seq:4});if(change==='persona')f.c.characterCard.roleText='新角色';if(change==='sleep')f.c.sleepPolicy={enabled:true};if(change==='route')f.state.sessions=[];if(change==='cancel')f.controller.abort();return {texts:['旧回复']}})
 await assert.rejects(f.run(undefined,{surface:'public-comment'}));assert.equal(f.count(),1)
})
test('unavailable generation or changed numeric/link facts falls back once without execution retries',async()=>{
 const f=fixture();f.respond(()=>{throw Error('provider failed')});const r=await f.run(undefined,{surface:'public-comment'});assert.equal(r.audit.status,'fallback');assert.equal(r.parts[0].text,'原始草稿');await f.run(undefined,{surface:'public-comment'});assert.equal(f.count(),1)
 const g=fixture();g.respond(()=>({texts:['一共99条 https://wrong.test/']}));const draft=[{text:'有18条 https://source.test/'}];assert.deepEqual((await g.run(draft,{surface:'public-comment'})).parts,draft)
})
test('exact text must be present in the current user request; detailed/code and attachment-only output bypass rewriting',async()=>{
 const f=fixture();const p=[{text:'PRIVATE CHAT MESSAGE'}];assert.equal((await f.run(p,{preserveText:true})).audit.status,'preserved');assert.equal(f.count(),0)
 await f.run([{text:'任意自写文字'}],{preserveText:true});assert.equal(f.count(),0)
 await f.run([{text:'```js\nx=1\n```'}]);await f.run([{text:'完整详细回答'}],{inlineDetails:true});await f.run([{stickerId:'s'}]);assert.equal(f.count(),0)
})
test('text and sticker ordering is preserved, never silently regrouped',async()=>{
 const f=fixture();f.respond(()=>({texts:['先说','再说']}));const p=[{text:'第一句'},{stickerId:'s'},{text:'第二句'}]
 assert.deepEqual((await f.run(p)).parts,p);assert.equal(f.count(),0)
 const g=fixture();g.respond(()=>({texts:['合成一句']}));assert.deepEqual((await g.run(p)).parts,p)
})
test('Bilibili posts rendered text once; differing rendering cannot bypass original-request deduplication',async()=>{
 const f=fixture();f.state.channels.push({id:'b',platform:'bilibili',companionId:'c',accountId:'123',enabled:true,updatedAt:1,bilibili:{privateActions:true,autonomousActions:true,enabledActions:['comment']}})
 let posts=0,posted
 const service=new BilibiliService(f.store,async(_id,_op,params)=>{posts++;posted=params;return {ok:true}}),tool=bilibiliTool('c',f.store,service,f.ctx)
 const args={action:'call',operation:'comment',params:{bvid:'BV1xx411c7mD',text:'评论草稿'}}
 const result=await tool.execute(args,f.exec);assert.equal(posts,1);assert.equal(posted.text,'人物的回应');assert.equal(result.personaDelivery.status,'rendered');assert.equal(result.submittedText,'人物的回应');assert.doesNotMatch(tool.output.render({},result)[0].text,/personaDelivery|durationMs/)
 await assert.rejects(tool.execute(args,f.exec),/重复/);assert.equal(posts,1)
 await assert.rejects(service.call('b','comment',{...args.params,text:'另一种表达'},f.exec.signal,()=>{},'/tmp',args.params),/重复/);assert.equal(posts,1)
})
test('Bilibili account/config revocation during composition prevents any post',async()=>{
 const f=fixture();const c={id:'b',platform:'bilibili',companionId:'c',accountId:'123',enabled:true,updatedAt:1,bilibili:{privateActions:true,autonomousActions:true,enabledActions:['comment']}};f.state.channels.push(c)
 let posts=0;const service=new BilibiliService(f.store,async()=>{posts++;return {}}),tool=bilibiliTool('c',f.store,service,f.ctx)
 f.respond(()=>{c.accountId='456';c.updatedAt++;return {texts:['过时的评论']}})
 await assert.rejects(tool.execute({action:'call',operation:'comment',params:{bvid:'BV1xx411c7mD',text:'草稿'}},f.exec));assert.equal(posts,0)
})

test('runtime snapshots cannot replace the real user input or expose private snapshots to public rendering',async()=>{
 const f=fixture();f.events.push({seq:4,type:'user/message',data:{source:{kind:'runtime-context',form:'snapshot'},content:[{type:'text',text:'INTERNAL STATE NOT USER'}]}})
 await f.run(undefined,{surface:'public-comment'});const request=JSON.stringify(f.request());assert.doesNotMatch(request,/PRIVATE CHAT MESSAGE|INTERNAL STATE NOT USER/)
})
test('local habits reach local expression but never public comments; provenance stays out of model prompts',async()=>{
 const {observeHabit}=await import('../lib/character/habits.js'),f=fixture();f.c.idleContact={habitsEnabled:true}
 const now=Date.now()
 for(let i=0;i<3;i++)observeHabit(f.c,'local:route',{kind:'expression',text:'LOCAL_STYLE_ONLY'},{id:'e'+i,at:now+i*3*3600000,excerpt:'PRIVATE_HABIT_EVIDENCE'},now+i*3*3600000)
 await f.run();assert.equal(f.count(),0)
 await f.run([{text:'公开评论'}],{surface:'public-comment',single:true});assert.doesNotMatch(JSON.stringify(f.request()),/LOCAL_STYLE_ONLY|PRIVATE_HABIT_EVIDENCE/)
})


test('authored chat preserves words, segments and sticker order without a model request',async()=>{
 const f=fixture(),parts=[{text:'第一句'},{stickerId:'s'},{text:'第二句'}]
 const out=await f.run(parts,{authored:true})
 assert.deepEqual(out.parts,parts);assert.equal(out.audit.reason,'authored-text');assert.equal(f.count(),0)
 f.events.push({...f.events[1],seq:4})
 assert.throws(()=>out.validate(),/变化/)
})
test('authored flag cannot skip public comment validation and rendering',async()=>{
 const f=fixture();const out=await f.run([{text:'评论'}],{authored:true,surface:'public-comment',single:true})
 assert.equal(f.count(),1);assert.equal(out.audit.status,'rendered')
})
