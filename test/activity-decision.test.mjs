import test from 'node:test'
import assert from 'node:assert/strict'
import {saveNextActivity,saveTurnInterest,quietInterest,renderActivityDecisionContext,withActivityChoiceSchema} from '../lib/character/activity-decision.js'
import {chatTools} from '../lib/chat/tools.js'
import {idleActivityFinishTool} from '../lib/character/activity-tool.js'
import {IDLE_CONTACT_NOTICE} from '../lib/character/idle-contact.js'
import {PartnerAgentRuntime} from '../lib/agent-runtime.js'
function fixture(){
 const now=Date.now(),c={id:'c',updatedAt:1,characterCard:{enabled:true,segmentedReplies:true,stickersEnabled:true},idleContact:{enabled:true,routeId:'r',idleMinutes:120}},r={id:'r',sessionId:'s',companionId:'c',kind:'local',channelId:'local',userId:'local',lastMessageAt:now}
 const state={companions:[c],sessions:[r],channels:[],pairings:[],notificationDeliveries:[]},events=[{type:'turn/start',seq:1,time:now,data:{turn:1}},{type:'user/message',seq:2,time:now,data:{id:'u',source:{kind:'user'},content:[{type:'text',text:'刚才那个分享还挺有意思'}]}}]
 let ended=0;const followed=[],store={snapshot:()=>state,update:async fn=>fn(state),isCompanionRemoving:()=>false,subscribe:()=>()=>{}},agent={status:'idle',session:{id:'s',seq:2,snapshotEvents:()=>events},followup:m=>followed.push(m)},exec={agent,signal:new AbortController().signal,concludeTurn:()=>ended++}
 const runtime=new PartnerAgentRuntime({agents:{get:()=>agent}},store,'/tmp');runtime.ensureAgent=async()=>agent;runtime.isArchived=()=>false
 const choose=(v)=>saveNextActivity('c',store,'s',()=>events,v,exec.signal)
 return {c,r,state,events,store,agent,exec,runtime,followed,choose,ended:()=>ended,reply:chatTools('c',store,{},{},{},'').find(t=>t.name==='partner_chat_reply')}
}
test('no optional choice means no plan, random draw or extra model call',async()=>{const f=fixture();await f.reply.execute({messages:[{text:'我也觉得'}]},f.exec);assert.equal(f.c.activityPlan,undefined);assert.equal(f.ended(),1)})
for(const kind of ['continue','topic','task','explore','social'])test('reply can author '+kind+' and only delivery makes it ready',async()=>{
 const f=fixture(),input={kind,reason:'刚才聊到的公开游戏内容还想了解一点'}
 await f.reply.execute({messages:[{text:'我还挺喜欢那个设计'}],nextActivity:input},f.exec)
 assert.equal(f.ended(),1);assert.equal(f.c.activityPlan.kind,kind);assert.equal(f.c.activityPlan.status,'waiting');assert.ok(f.c.activityPlan.dueAt<=Date.now());assert.equal(f.c.activityDecision.outcome,'scheduled')
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 await f.runtime.replyDelivered({routeId:'r',sessionId:'s',userMessageId:'u'});assert.equal(f.c.activityPlan.status,'pending')
 await f.runtime.idleContact('c');assert.equal(f.followed.length,1);assert.equal(f.r.idleContactState.depth,1)
 await f.runtime.idleContact('c');assert.equal(f.followed.length,1)
})
test('new message cancels old intention before any autonomous work',async()=>{const f=fixture();await f.choose({kind:'topic',reason:'由刚才的游戏想到另一个玩法'});await f.runtime.cancelPostReply('c',undefined,'s');assert.equal(f.c.activityPlan.status,'cancelled');await f.runtime.idleContact('c');assert.equal(f.followed.length,0)})
test('optional permission or continuation-limit refusal never blocks normal final reply',async()=>{
 const f=fixture();f.c.idleContact.enabled=false;await f.reply.execute({messages:[{text:'好呀'}],nextActivity:{kind:'social',reason:'想去看下公开动态'}},f.exec);assert.equal(f.ended(),1);assert.equal(f.c.activityPlan,undefined);assert.equal(f.c.activityDecision.outcome,'declined')
})
test('activity finish can choose its next step without sending a synthetic message',async()=>{
 const f=fixture();f.r.idleContactState={kind:'autonomous',messageId:'a',userMessageId:'u',depth:1};f.events.push({type:'turn/start',seq:3,time:Date.now(),data:{turn:2}},{type:'user/message',seq:4,time:Date.now(),data:{id:'a',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}})
 const result=await idleActivityFinishTool('c',f.store).execute({reason:'已看完公开动态 没有需要私聊汇报的事',nextActivity:{kind:'explore',reason:'想看看刚才作者提到的另一款游戏',delayMinutes:5}},f.exec)
 assert.equal(result.kind,'partner-activity-silent-v1');assert.equal(f.c.activityPlan.status,'waiting');assert.equal(f.c.activityPlan.depth,2)
 f.r.idleContactState.depth=3;await f.choose({kind:'topic',reason:'还有一个想法'});assert.equal(f.c.activityDecision.outcome,'declined');assert.match(f.c.activityDecision.detail,/3 轮/)
})
test('none cancels only this inputs pending plan and the decision is bounded',async()=>{const f=fixture();await f.choose({kind:'continue',reason:'还有半句想说'});await f.choose({kind:'none',reason:'这句现在不必再补了',cancelPending:true});assert.equal(f.c.activityPlan.status,'cancelled');assert.equal(f.c.activityDecision.outcome,'none');await assert.rejects(f.choose({kind:'task',reason:'x'.repeat(301)}),/意图/);assert.equal(f.c.activityDecision.reason,'这句现在不必再补了')})
test('choice context does not embed a persona, catalogue contents or fixed catchphrases',()=>{
 const f=fixture(),text=renderActivityDecisionContext(f.state,f.c,'s',f.events,[{platform:'qq',activities:[{title:'QQ 空间浏览'}]}]);assert.match(text,/nextActivity/);assert.match(text,/空间浏览/);assert.match(text,/不自动拉长间隔/);assert.doesNotMatch(text,/哥哥|弟弟|必发|schema/)
 f.c.idleContact.enabled=false;assert.equal(renderActivityDecisionContext(f.state,f.c,'s',f.events,[]),'')
})
test('intermediate speech cannot quietly schedule a second turn',async()=>{const f=fixture();await assert.rejects(f.reply.execute({messages:[{text:'等我一下'}],continueTurn:true,nextActivity:{kind:'task',reason:'继续处理'}},f.exec),/最终回复/);assert.equal(f.c.activityPlan,undefined)})

test('a shared local session cannot steal channel decision provenance',async()=>{
 const f=fixture();f.state.channels.push({id:'qq',companionId:'c',platform:'qq',enabled:true,qq:{privateReplies:true,identityBinding:{enabled:true,qqIds:['12345678']}}})
 f.state.sessions.push({id:'channel-route',sessionId:'s',companionId:'c',kind:'channel',channelId:'qq',userId:'12345678',inboundMessageIds:['u']});f.state.pairings.push({channelId:'qq',userId:'12345678',status:'approved'})
 await f.choose({kind:'continue',reason:'接着当前这个人的话'});assert.equal(f.c.activityDecision.routeId,'channel-route');assert.equal(f.c.activityPlan.sourceRouteId,'channel-route');assert.equal(f.c.activityPlan.targetRouteId,'channel-route')
})

test('explicit none can be cheap and preserves a separately authored plan by default',async()=>{const f=fixture();await f.choose({kind:'explore',reason:'还有一条公开内容想看'});const id=f.c.activityPlan.id;await f.choose({kind:'none'});assert.equal(f.c.activityPlan.id,id);assert.equal(f.c.activityPlan.status,'waiting');assert.equal(f.c.activityDecision.outcome,'none')})
test('eligible native presentation requests a choice but never mutates shared guest schema',()=>{const f=fixture(),original=f.reply.parameters;const selected=withActivityChoiceSchema(f.reply,true);assert.ok(selected.parameters.required.includes('interest'));assert.equal(f.reply.parameters,original);assert.ok(!original.required?.includes('interest'));assert.equal(withActivityChoiceSchema(f.reply,false),f.reply)})

test('engaged interest without a concrete plan waits for receipt and a short pause before one wake',async()=>{
 const f=fixture();await f.reply.execute({messages:[{text:'这也太好了'}],nextActivity:{kind:'none'},interest:{state:'engaged',focus:'还想一起聊刚才的好消息',kind:'continue'}},f.exec)
 const p=f.c.activityPlan;assert.equal(p.trigger,'interest');assert.equal(p.status,'waiting');assert.ok(p.dueAt>Date.now());assert.equal(f.c.activityInterest.state,'engaged')
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 await f.runtime.replyDelivered({routeId:'r',sessionId:'s',userMessageId:'u'});await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 p.dueAt=Date.now()-1;await Promise.all([f.runtime.idleContact('c'),f.runtime.idleContact('c')]);assert.equal(f.followed.length,1);assert.equal(f.c.interestWakeHistory.length,1)
 assert.match(f.followed[0].content[0].text,/不是新任务/)
})
test('explicit plans win; interest does not replace another source or duplicate an arrangement',async()=>{
 const f=fixture();await f.choose({kind:'explore',reason:'稍后看这个作者的新内容',delayMinutes:10});const id=f.c.activityPlan.id
 await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'engaged',focus:'还想看那个内容',kind:'explore'},f.exec.signal)
 assert.equal(f.c.activityPlan.id,id);assert.equal(f.c.activityPlan.trigger,undefined)
})
test('quiet pauses autonomous wake for this input, new messages immediately revoke the quiet state',async()=>{
 const f=fixture();await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'quiet',focus:'对方要求先不打扰',kind:'continue'},f.exec.signal)
 assert.equal(quietInterest(f.c,'r','u'),true);assert.equal(quietInterest(f.c,'other','u'),false)
 f.r.lastMessageAt=Date.now()-3*3600000;f.events[1].time=f.r.lastMessageAt
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0)
 await f.runtime.cancelPostReply('c',undefined,'s');assert.equal(quietInterest(f.c,'r','u'),false)
})
test('interest rate limit is shared, persisted, and checked again atomically on claim',async()=>{
 const f=fixture(),raw={state:'engaged',focus:'还有话想说',kind:'continue'}
 await saveTurnInterest('c',f.store,'s',()=>f.events,raw,f.exec.signal)
 await f.runtime.replyDelivered({routeId:'r',sessionId:'s',userMessageId:'u'});f.c.activityPlan.dueAt=Date.now()-1
 f.c.interestWakeHistory=[Date.now()-2000,Date.now()-1000]
 await f.runtime.idleContact('c');assert.equal(f.followed.length,0);assert.equal(f.c.activityPlan.status,'cancelled')
 await saveTurnInterest('c',f.store,'s',()=>f.events,raw,f.exec.signal);assert.match(f.c.activityInterest.detail,/两次/)
 f.c.interestWakeHistory=[Date.now()-3600001];await saveTurnInterest('c',f.store,'s',()=>f.events,raw,f.exec.signal);assert.equal(f.c.activityPlan.status,'waiting')
})
test('expired interest is not replayed, and settling cancels only its own pending opportunity',async()=>{
 const f=fixture();await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'engaged',focus:'还想聊',kind:'continue'},f.exec.signal)
 f.c.activityPlan.expiresAt=Date.now()-1;await f.runtime.idleContact('c');assert.equal(f.c.activityPlan.status,'cancelled');assert.equal(f.followed.length,0)
 await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'engaged',focus:'新的想法',kind:'continue'},f.exec.signal)
 await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'settled',focus:'此刻满足了',kind:'continue'},f.exec.signal);assert.equal(f.c.activityPlan.status,'cancelled')
})
test('interest cannot bypass continuous-task budget or a disabled autonomy switch',async()=>{
 const f=fixture();f.c.idleContact.enabled=false
 await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'engaged',focus:'还想聊',kind:'continue'},f.exec.signal);assert.equal(f.c.activityPlan,undefined)
 f.c.idleContact.enabled=true;f.r.idleContactState={kind:'continuous',messageId:'a',userMessageId:'u'}
 f.events.push({type:'turn/start',seq:3,data:{turn:2}},{type:'user/message',seq:4,time:Date.now(),data:{id:'a',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:IDLE_CONTACT_NOTICE}}})
 await saveTurnInterest('c',f.store,'s',()=>f.events,{state:'engaged',focus:'还想聊',kind:'continue'},f.exec.signal);assert.equal(f.c.activityPlan,undefined)
})
test('balanced bounded activity directions retain later platforms',()=>{
 const f=fixture(),catalog=[{platform:'qq',activities:Array.from({length:25},(_,i)=>({title:'QQ '+i}))},{platform:'qq',activities:[{title:'QQ 空间',discoveryOperations:['feeds']}]},{platform:'bilibili',activities:[{title:'B站浏览',discoveryOperations:['hot']},{title:'B站互动'}]}]
 const text=renderActivityDecisionContext(f.state,f.c,'s',f.events,catalog),options=JSON.parse(text.slice(text.lastIndexOf('\n')+1)).availableDirections
 assert.equal(options.length,12);assert.equal(new Set(options).size,12);assert.equal(options[0],'qq · QQ 空间');assert.equal(options[1],'bilibili · B站浏览')
})
