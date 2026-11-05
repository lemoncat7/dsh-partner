import test from 'node:test'
import assert from 'node:assert/strict'
import {observeHabit,renderHabits,habitScope,habitsEnabled} from '../lib/character/habits.js'
import {InteractionReviewService} from '../lib/character/interaction-review.js'
import {createDefaultCompanion} from '../lib/domain.js'
import {emptyCharacterCard} from '../lib/character/domain.js'
const make=()=>({...createDefaultCompanion(),id:'c',characterCard:{...emptyCharacterCard(),enabled:true,roleText:'固定角色'},idleContact:{enabled:true,routeId:'r',idleMinutes:30,habitsEnabled:true},automation:{memory:{enabled:true,retentionDays:0}}})
test('three distinct sources across six hours form a scoped preference without rewriting identity',()=>{
 const c=make(),before=structuredClone(c),now=Date.now(),p={text:'喜欢呆猫表情',kind:'interest'}
 for(let i=0;i<3;i++)observeHabit(c,'room',p,{id:'u'+i,at:now+i*3*3600000,excerpt:'这张猫好呆'},now+i*3*3600000)
 assert.equal(c.habits[0].status,'active');assert.match(renderHabits(c,'room'),/呆猫/);assert.equal(renderHabits(c,'another'),'')
 delete c.habits;assert.deepEqual(c,before)
})
test('replaying a source, rapid repetition, pause, disable, expiry and baseline edits cannot silently train preferences',()=>{
 const c=make(),now=Date.now(),p={text:'短一点',kind:'expression'},e={id:'u',at:now,excerpt:'短点'}
 observeHabit(c,'s',p,e);observeHabit(c,'s',p,e);assert.equal(c.habits[0].evidence.length,1)
 observeHabit(c,'s',p,{...e,id:'u2'});observeHabit(c,'s',p,{...e,id:'u3'});assert.equal(renderHabits(c,'s'),'')
 c.habits[0].status='active';c.idleContact.habitsEnabled=false;assert.equal(renderHabits(c,'s'),'');c.idleContact.habitsEnabled=true
 c.habits[0].status='paused';assert.equal(observeHabit(c,'s',p,{...e,id:'u4'}),false)
 c.habits[0].status='active';c.characterCard.roleText='用户新设定';assert.equal(renderHabits(c,'s'),'')
 assert.equal(observeHabit(c,'s',p,{...e,id:'u4'}),false)
})
test('scope keys join speakers in the same group, isolate private chats and reject global expression',()=>{
 const a={kind:'channel',channelId:'qq',userId:'group:123:u1'},b={...a,userId:'group:123:u2'}
 assert.equal(habitScope(a),habitScope(b));assert.notEqual(habitScope(a),habitScope({...a,userId:'u1'}))
 assert.throws(()=>observeHabit(make(),'global',{kind:'expression',text:'喊主人'},{id:'u',at:Date.now(),excerpt:'x'}),/仅接纳/)
})
test('bounded habits, fresh revision candidate and removal preserve fixed card',()=>{
 const c=make(),now=Date.now()
 for(let i=0;i<20;i++)observeHabit(c,'s',{kind:'interest',text:'兴趣'+i},{id:'u'+i,at:now,excerpt:'依据'})
 assert.equal(c.habits.length,12)
 const h=c.habits[0];h.status='active';observeHabit(c,'s',{id:h.id,kind:'interest',text:'新偏好'},{id:'next',at:now+1,excerpt:'变化'})
 assert.equal(h.status,'candidate');assert.equal(h.evidence.length,1)
 observeHabit(c,'s',{id:h.id,action:'remove'},{id:'remove',at:now,excerpt:'不喜欢了'});assert.ok(!c.habits.find(x=>x.id===h.id))
})
test('non-owner private and group evidence are eligible without awarding affection; earlier feedback is usable',async()=>{
 for(const userId of ['guest','group:100:guest']){
  const c=make(),now=Date.now(),route={id:'r',companionId:'c',sessionId:'s',kind:'channel',channelId:'qq',userId,inboundMessageIds:['u']}
  const state={companions:[c],sessions:[route],channels:[{id:'qq',companionId:'c',platform:'qq',enabled:true}],pairings:[{channelId:'qq',userId,status:'approved'}]}
  // Matrix uses channel reply authorization without QQ-specific category fixtures.
  state.channels[0].platform='matrix'
  const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)}
  const service=new InteractionReviewService(store),old={id:'old',companionId:'c',sessionId:'s',scopeId:'scope',at:now-10000,user:'这里短点说就行',assistant:'好',userMessageIds:['old'],sourceRouteIds:['r'],interactionEligible:false},turn={...old,id:'new',at:now,user:'哈哈',userMessageIds:['u']}
  const r=service.prepare(turn,now,[old]);assert.ok(r?.request.habits);assert.equal(r.request.affection,false)
  await service.apply(turn,{request:r.request,evaluation:{habits:{reason:'先观察表达偏好',proposals:[{kind:'expression',text:'此处简短接话',sourceId:'old',evidence:'这里短点说就行'}]}}})
  assert.equal(c.habits.length,1);assert.equal(c.characterCard.roleText,'固定角色');assert.equal(c.affection,undefined)
  c.characterCard.roleText='手动改';await service.apply(turn,{request:r.request,evaluation:{habits:{reason:'改',proposals:[]}}});assert.equal(c.habits.length,1)
 }
})
test('deleted habit cannot be recreated from old evidence; newer experiences start a fresh candidate',()=>{
 const c=make(),now=Date.now(),p={text:'喜欢猫图',kind:'interest'};c.habitDismissals=[{scope:'s',text:p.text,at:now}]
 assert.equal(observeHabit(c,'s',p,{id:'old',at:now-1,excerpt:'猫图'}),false)
 assert.equal(observeHabit(c,'s',p,{id:'new',at:now+1,excerpt:'猫图'}),true);assert.equal(c.habits[0].status,'candidate')
})
test('invalid second proposal does not partially save first; disabled and revoked routes cannot apply',async()=>{
 const c=make(),now=Date.now(),route={id:'r',companionId:'c',sessionId:'s',kind:'local',channelId:'@local',userId:'owner'},state={companions:[c],sessions:[route],channels:[],pairings:[]}
 const store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)},service=new InteractionReviewService(store)
 const turn={id:'t',companionId:'c',sessionId:'s',scopeId:'scope',at:now,user:'以后回复少用反问句',assistant:'好',userMessageIds:['u'],sourceRouteIds:['r']}
 const r=service.prepare(turn,now)
 const good={kind:'expression',text:'少反问',sourceId:'t',evidence:'以后回复少用反问句'}
 await service.apply(turn,{request:r.request,evaluation:{habits:{reason:'反馈',proposals:[good,{...good,evidence:'编造'}]}}})
 assert.equal(c.habits,undefined);assert.equal(c.habitCheck.outcome,'failed')
 state.sessions=[];await service.apply(turn,{request:r.request,evaluation:{habits:{reason:'反馈',proposals:[good]}}});assert.equal(c.habits,undefined)
})
test('ordinary acknowledgements and another persons interests do not become companion habits',async()=>{
 for(const [user,kind,text] of [['哈哈','expression','喜欢说哈哈'],['以后我每天都要看猫图','interest','喜欢猫图']]){
  const c=make(),now=Date.now(),state={companions:[c],sessions:[{id:'r',companionId:'c',sessionId:'s',kind:'local',channelId:'@local',userId:'owner'}],channels:[],pairings:[]}
  const service=new InteractionReviewService({snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)})
  const turn={id:'t',companionId:'c',sessionId:'s',scopeId:'scope',at:now,user,assistant:'好',userMessageIds:['u'],sourceRouteIds:['r']},r=service.prepare(turn,now)
  await service.apply(turn,{request:r.request,evaluation:{habits:{reason:'形成习惯',proposals:[{kind,text,evidence:user,sourceId:'t'}]}}})
  assert.equal(c.habits,undefined);assert.equal(c.habitCheck.outcome,'unchanged')
 }
})
test('older evidence cannot refresh a habit after its short evidence history rolls forward',()=>{
 const c=make(),now=Date.now(),p={kind:'interest',text:'喜欢画画'}
 for(let i=0;i<7;i++)observeHabit(c,'global',p,{id:'event'+i,at:now+i*3600000,excerpt:'画完了'},now+i*3600000)
 const before=structuredClone(c.habits)
 assert.equal(observeHabit(c,'global',p,{id:'event0',at:now,excerpt:'画完了'}),false)
 assert.deepEqual(c.habits,before)
})
test('habit tool supports local activities, requires substantive completed evidence and rejects ordinary user writes',async()=>{
 const {habitTool}=await import('../lib/character/habit-tool.js')
 const c=make(),now=Date.now(),route={id:'r',companionId:'c',sessionId:'s',kind:'local',channelId:'@local',userId:'owner',idleContactState:{messageId:'idle',userMessageId:'u',policyRevision:c.updatedAt}},state={companions:[c],sessions:[route],channels:[],pairings:[]}
 const user={type:'user/message',seq:1,data:{id:'u',source:{kind:'user'},content:[]}},notice={type:'user/message',seq:3,data:{id:'idle',source:{kind:'plugin:@lemoncat7/dsh-partner',form:'notice',summary:'伙伴闲时主动联系'},content:[]}}
 let events=[user,{type:'turn/start',seq:2},notice]
 const exec={agent:{session:{id:'s',snapshotEvents:()=>events}},signal:new AbortController().signal},store={snapshot:()=>structuredClone(state),isCompanionRemoving:()=>false,update:async fn=>fn(state)},tool=habitTool('c',store)
 c.activityJournal=[{id:'a',sessionId:'s',at:now,summary:'画了猫咪漫画',silent:true,tools:[{name:'generate_image',ok:true}],artifacts:[]},{id:'bad',sessionId:'s',at:now,summary:'记下了喜欢猫图',silent:true,tools:[{name:'partner_habits:observe',ok:true}],artifacts:[]}]
 const data=JSON.parse(await tool.execute({action:'inspect'},exec));assert.deepEqual(data.sources.map(x=>x.id),['a'])
 await tool.execute({action:'observe',text:'喜欢画猫咪漫画',sourceId:'a',evidence:'画了猫咪漫画'},exec)
 assert.equal(c.habits[0].scope,'global');assert.equal(c.habits[0].status,'candidate')
 await assert.rejects(tool.execute({action:'observe',text:'喜欢猫',sourceId:'bad',evidence:'记下'},exec),/真实依据/)
 events=[user];await assert.rejects(tool.execute({action:'observe',text:'变更',sourceId:'a',evidence:'画了'},exec),/自主活动/)
})
