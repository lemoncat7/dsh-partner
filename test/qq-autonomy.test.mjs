import test from 'node:test'
import assert from 'node:assert/strict'
import {QqGroupAutonomy,SPONTANEOUS_INTERVAL_MS} from '../lib/channels/qq/autonomy.js'
import {scoreGroupReply,routeGroupReply,CONVERSATION_WINDOW_MS} from '../lib/channels/qq/reply-rules.js'
const event={id:'one',sender:'group:12345678:22345678',text:'小明你怎么看？',qqGroup:{groupId:'12345678',userId:'22345678',senderName:'朋友',autonomous:true,mentioned:false}}
const companion={name:'小明',relationshipText:'用户是哥哥，角色是弟弟'}
const context={name:'小明',owner:true,addresses:['弟弟'],affection:20,now:1000000,seed:'test'}
const signal=()=>new AbortController().signal
const forbidden={get(){throw Error('must not resolve a remote model')}}
const unavailable=async()=>undefined
const input=(text,group={},id=text)=>({...event,id,text,qqGroup:{...event.qqGroup,...group}})

test('explicit calling and validated reply relationships take precedence over semantics',()=>{
 for(const text of ['小明？','小明你怎么看','弟弟 弟弟','弟弟人呢？']){
  const result=scoreGroupReply(input(text),context);assert.equal(result.reply,true,text);assert.equal(result.route,'direct')
 }
 assert.equal(routeGroupReply(input('小明天去不去'),context),undefined)
 assert.equal(scoreGroupReply(input('你好',{otherMention:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('小明？',{replyTo:'other',hasReply:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('嗯',{replyTo:'self',hasReply:true}),context).route,'direct')
 assert.equal(scoreGroupReply(input('你好',{otherMention:true,mentioned:true}),context).reply,true)
 assert.equal(routeGroupReply(input('弟弟人呢？'),{...context,owner:false}),undefined,'relationship terms never prove ownership')
})
test('recent conversation keeps substantive followups but leaves closing acknowledgements quiet',async()=>{
 let calls=0;const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);assert.equal(await gate.shouldReply('c',first,companion,signal()),true);gate.replied('c',first,'刚刚回来了')
 for(const text of ['哇 太棒了','然后呢','我都没说那个','😀','That is awesome!','え、すごいね']){
  const e=input(text);gate.observe('c',e);assert.equal(await gate.shouldReply('c',e,companion,signal()),true,text)
  assert.equal(gate.status('c').route,'continuation')
 }
 assert.equal(await gate.shouldReply('c',input('好的'),companion,signal()),false)
 assert.equal(calls,0,'immediate same-speaker followups do not await another classification')
})
test('another speaker does not erase a thread or inherit it; channels, groups and expiry are separate',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'刚刚回来了')
 const other=input('天气不错',{userId:'33445678'});gate.observe('c',other);await gate.shouldReply('c',other,companion,signal());assert.equal(gate.status('c').route,'fallback')
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'continuation')
 await gate.shouldReply('other-channel',follow,companion,signal());assert.equal(gate.status('other-channel').route,'fallback')
 await gate.shouldReply('c',input('太棒了',{groupId:'87654321'}),companion,signal());assert.equal(gate.status('c').route,'fallback')
 now+=CONVERSATION_WINDOW_MS;await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback');assert.equal(calls,5)
})
test('only delivery establishes continuity, redirect and explicit stopping close the correct thread',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 const first=input('小明？');gate.observe('c',first);await gate.shouldReply('c',first,companion,signal())
 const follow=input('太棒了');gate.observe('c',follow);await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','mere admission is not a reply')
 gate.replied('c',first,'你好')
 const redirect=input('你在吗',{otherMention:true});gate.observe('c',redirect)
 gate.replied('c',first,'late delivery');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback','late old send does not reopen redirected thread')
 gate.observe('c',first);gate.replied('c',first,'你好')
 const stop=input('不用回复了');gate.observe('c',stop);assert.equal(await gate.shouldReply('c',stop,companion,signal()),false)
 gate.replied('c',stop,'');await gate.shouldReply('c',follow,companion,signal());assert.equal(gate.status('c').route,'fallback')
})
test('uncertain new group chatter stays quiet; direct requests and genuine continuations remain reachable',()=>{
 for(const semantic of [undefined,{label:'other',confidence:.6,margin:.3},{label:'close',confidence:.8,margin:.15},{label:'engage',confidence:.5,margin:.2}]){
  assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic}).reply,false)
  assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic,recent:{at:context.now,text:'看什么'}}).reply,true)
 }
 for(const label of ['address','engage'])assert.equal(scoreGroupReply(input('给你看看'),{...context,semantic:{label,confidence:.8,margin:.5}}).reply,true)
 for(const label of ['other','close','background'])for(const recent of [undefined,{at:context.now,text:'你好'}])assert.equal(scoreGroupReply(input('普通消息'),{...context,recent,semantic:{label,confidence:.9,margin:.6}}).reply,false)
 assert.equal(scoreGroupReply(input('好的'),{...context,recent:{at:context.now,text:'你来了吗'}}).reply,false)
 assert.equal(scoreGroupReply(input('不用回复了',{mentioned:true}),context).reply,false)
})
test('classifier outage does not admit every group line; explicit requests and cancellation remain intact',async()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{throw Error('service down')})
 assert.equal(await gate.shouldReply('c',input('我来了'),companion,signal()),false)
 assert.equal(await gate.shouldReply('c',input('小明帮我看看'),companion,signal()),true)
 const controller=new AbortController();controller.abort()
 await assert.rejects(gate.shouldReply('c',event,companion,controller.signal))
 const lateController=new AbortController(),late=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{lateController.abort();return undefined})
 await assert.rejects(late.shouldReply('c',input('我来了'),companion,lateController.signal))
})
test('bounded observations exclude the current and later events from the context of a queued message',()=>{
 const gate=new QqGroupAutonomy(forbidden,()=>context.now,unavailable)
 for(let i=0;i<100;i++)gate.observe('c',input('message-'+i,{},String(i)))
 const rows=JSON.parse(gate.context('c',input('message-98',{},'98')))
 assert.equal(rows.length,16);assert.equal(rows.at(-1).text,'message-97')
})

test('shared sleep stops an ongoing hot group thread before semantic classification',async()=>{
 let calls=0;const gate=new QqGroupAutonomy(forbidden,()=>context.now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'聊着呢')
 const sleeping={...companion,sleepPolicy:{enabled:true},sleepState:{episode:{wakeAt:context.now+60000}}}
 assert.equal(await gate.shouldReply('c',input('然后呢'),sleeping,signal()),false)
 assert.equal(calls,0);assert.match(gate.status('c').reason,/睡眠/)
 assert.equal(await gate.shouldReply('c',input('醒醒',{mentioned:true}),sleeping,signal()),true)
 sleeping.sleepState.episode.wokeAt=context.now
 assert.equal(await gate.shouldReply('c',input('然后呢'),sleeping,signal()),true)
})

test('human exchanges retain selective chime-in opportunities while direct invitations bypass the spontaneous interval',async()=>{
 let now=context.now,calls=0
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return {label:'engage',confidence:.95,margin:.9}})
 gate.observe('c',input('上线了已经',{userId:'33445678'},'other'))
 now+=2000
 let chosen
 for(let i=0;i<100;i++){
  const chatter=input('这话听起来怪怪的',{},'candidate-'+i);gate.observe('c',chatter)
  if(await gate.shouldReply('c',chatter,companion,signal())){chosen=chatter;break}
 }
 assert.ok(chosen,'human-to-human chatter is no longer categorically rejected')
 assert.equal(gate.status('c').route,'opportunity');assert.ok(calls>0)
 const before=calls,mention=input('帮我看看',{mentioned:true});gate.observe('c',mention)
 assert.equal(await gate.shouldReply('c',mention,companion,signal()),true);assert.equal(calls,before)
 assert.equal(await gate.shouldReply('c',input('？'),companion,signal()),false);assert.equal(calls,before)
 const invitation=input('大家怎么看这个更新');gate.observe('c',invitation)
 assert.equal(await gate.shouldReply('c',invitation,companion,signal()),false,'unsolicited admissions cannot accumulate while earlier work waits')
 now+=SPONTANEOUS_INTERVAL_MS
 assert.equal(await gate.shouldReply('c',invitation,companion,signal()),true)
})

test('semantic chime-ins are optional, room-limited, and never override explicit other-person addressing',async()=>{
 const labels={label:'engage',confidence:.95,margin:.9},shared={...context,otherConversation:true,semantic:labels}
 const decisions=Array.from({length:200},(_,i)=>scoreGroupReply(input('这个透视也太离谱了'),{...shared,seed:'room-message-'+i}))
 assert.ok(decisions.some(r=>r.reply));assert.ok(decisions.some(r=>!r.reply));assert.ok(decisions.every(r=>r.route==='opportunity'))
 assert.equal(scoreGroupReply(input('这个透视也太离谱了',{otherMention:true}),shared).reply,false)
 assert.equal(scoreGroupReply(input('普通消息'),{...shared,semantic:{label:'other',confidence:.95,margin:.8}}).reply,false)
 let now=context.now
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>labels)
 const e=input('大家觉得怎么样');gate.observe('a',e);assert.equal(await gate.shouldReply('a',e,companion,signal()),true)
 const second=input('还有一个大家来看看',{},'second');gate.observe('a',second);assert.equal(await gate.shouldReply('a',second,companion,signal()),false)
 gate.observe('b',second);assert.equal(await gate.shouldReply('b',second,companion,signal()),true)
 const another=input('大家来看看',{groupId:'87654321'},'another');gate.observe('a',another);assert.equal(await gate.shouldReply('a',another,companion,signal()),true)
 now+=SPONTANEOUS_INTERVAL_MS;assert.equal(await gate.shouldReply('a',second,companion,signal()),true)
})

test('room history includes factual seconds and delivered partner turns, and expires stale chatter',()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,unavailable)
 const first={...input('小明？',{},'first'),timestamp:now-5000};gate.observe('c',first)
 gate.replied('c',first,'我刚看见')
 now+=2000;const next={...input('然后呢',{},'next'),timestamp:now};gate.observe('c',next)
 const rows=JSON.parse(gate.context('c',next))
 assert.equal(rows[0].ageSeconds,7);assert.equal(rows[1].ageSeconds,2)
 assert.equal(rows[1].kind,'partner');assert.equal(rows[1].text,'我刚看见')
 assert.ok(!rows.some(r=>r.text==='然后呢'))
 now+=11*60000;const later=input('新话题',{},'later');gate.observe('c',later)
 assert.deepEqual(JSON.parse(gate.context('c',later)),[])
})

test('fast followups stop after redirects and cancellation; decision history is bounded metadata only',async()=>{
 let now=context.now,calls=0;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>{calls++;return undefined})
 const first=input('小明？');gate.observe('c',first);gate.replied('c',first,'你好')
 now+=2000;const follow=input('前面那张呢');gate.observe('c',follow)
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),true);assert.equal(calls,0)
 const stop=input('你们先聊，不用回我');gate.observe('c',stop)
 assert.equal(await gate.shouldReply('c',stop,companion,signal()),false)
 assert.equal(await gate.shouldReply('c',follow,companion,signal()),false)
 for(let i=0;i<45;i++)gate.record('c',input('private text',{},String(i)),'旁听')
 const history=gate.history('c');assert.equal(history.length,40);assert.equal(history.at(-1).messageId,'44')
 assert.ok(!JSON.stringify(history).includes('private text'));history.length=0;assert.equal(gate.history('c').length,40)
})

test('moderate clear engagement and context-related followups are admitted without weakening explicit negatives',()=>{
 const e=input('这一下也太厉害了')
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.606557,margin:.448234}}).reply,true)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18}}).reply,false)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18,contextSimilarity:.65}}).reply,true)
 assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.54,margin:.18,contextSimilarity:.1}}).reply,false)
 for(const label of ['other','close','background'])assert.equal(scoreGroupReply(e,{...context,semantic:{label,confidence:.9,margin:.6,contextSimilarity:.99}}).reply,false)
 for(const e of [input('不用回我'),input('好'),input('这下真厉害',{otherMention:true})])assert.equal(scoreGroupReply(e,{...context,semantic:{label:'engage',confidence:.95,margin:.8,contextSimilarity:.99}}).reply,false)
})
test('classification gets bounded fresh context plus last delivered reply, never other rooms or future messages',async()=>{
 let now=context.now;const seen=[]
 const gate=new QqGroupAutonomy(forbidden,()=>now,async(text,_signal,rows)=>{seen.push({text,rows});return {label:'background',confidence:.9,margin:.6}})
 const initial=input('小明？');gate.observe('c',initial);gate.replied('c',initial,'篮球打得不错')
 for(let i=0;i<8;i++){now+=1000;gate.observe('c',input('篮球比赛'+i+'x'.repeat(300),{userId:'33445678'},'background-'+i))}
 const current=input('最后那个球真绝了',{userId:'44556677'},'current');gate.observe('c',current)
 gate.observe('c',input('future secret',{userId:'33445678'},'future'))
 await gate.shouldReply('c',current,companion,signal())
 assert.equal(seen[0].text,current.text);assert.equal(seen[0].rows.length,4);assert.ok(seen[0].rows.every(t=>t.length<=48))
 assert.ok(seen[0].rows.includes('篮球打得不错'));assert.ok(!seen[0].rows.some(t=>t.includes('future secret')||t.includes(current.text)))
 assert.equal(gate.status('c').contextSize,4)
 assert.deepEqual(gate.attentionContext('other-channel',current),[])
 assert.deepEqual(gate.attentionContext('c',input('另一个群',{groupId:'87654321'})),[])
 now+=91000;assert.deepEqual(gate.attentionContext('c',current),[])
})
test('spontaneous admission resumes at five seconds while explicit requests bypass the short gap',async()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>({label:'engage',confidence:.7,margin:.4}))
 const first=input('大家看看这个');gate.observe('c',first);assert.equal(await gate.shouldReply('c',first,companion,signal()),true)
 now+=4999;const next=input('大家再看看这个',{},'second');gate.observe('c',next);assert.equal(await gate.shouldReply('c',next,companion,signal()),false)
 assert.equal(await gate.shouldReply('c',input('小明？'),companion,signal()),true)
 now+=1;assert.equal(await gate.shouldReply('c',next,companion,signal()),true)
 assert.equal(SPONTANEOUS_INTERVAL_MS,5000)
})

test('real local-model misses recover for open invitations and related reactions without admitting unrelated background',()=>{
 for(const text of ['大家觉得这个更新怎么样','有人知道这个怎么弄吗'])assert.equal(routeGroupReply(input(text),context).route,'opportunity')
 assert.equal(routeGroupReply(input('有人知道这个怎么弄吗',{otherMention:true}),context).reply,false)
 assert.equal(scoreGroupReply(input('最后那一下绝了'),{...context,semantic:{label:'close',confidence:.6333,margin:.3331,contextSimilarity:.7028}}).reply,true)
 assert.equal(scoreGroupReply(input('最后那一下绝了'),{...context,semantic:{label:'close',confidence:.6333,margin:.3331,contextSimilarity:.1}}).reply,false)
 assert.equal(scoreGroupReply(input('然后那个呢'),{...context,semantic:{label:'engage',confidence:.4965,margin:.1489,contextSimilarity:.4174}}).reply,true)
 assert.equal(scoreGroupReply(input('他住慈溪那边'),{...context,semantic:{label:'other',confidence:.3935,margin:.1254,contextSimilarity:.4233}}).reply,false)
 assert.equal(scoreGroupReply(input('晚安'),{...context,semantic:{label:'close',confidence:.63,margin:.33,contextSimilarity:.7}}).reply,false)
})

test('delivered group conversation continues across speakers without random admission or spontaneous delay',async()=>{
 let now=context.now;const prediction={label:'engage',confidence:.410724,margin:.209213,contextSimilarity:.711855}
 const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>prediction)
 const a=input('小明？');gate.observe('c',a);await gate.shouldReply('c',a,companion,signal());gate.replied('c',a,'3050这就要当公众号美工了')
 now+=1000
 for(const [i,label] of ['engage','close','other'].entries()){
  Object.assign(prediction,label!=='engage'?{label,confidence:.382166,margin:.092136,contextSimilarity:.516466}:{label})
  const e=input('其他成员顺着话题补充',{userId:'3344567'+i},'shared-'+i);gate.observe('c',e)
  assert.equal(await gate.shouldReply('c',e,companion,signal()),true)
  assert.equal(gate.status('c').route,'continuation');assert.equal(gate.status('c').probability,1)
  assert.match(gate.guidance('c',e),/1 秒前/);assert.match(gate.guidance('c',e),/共同对话/)
 }
})
test('shared conversation requires delivery, expires without sends, stays scoped and does not inherit future replies',async()=>{
 let now=context.now;const gate=new QqGroupAutonomy(forbidden,()=>now,async()=>({label:'engage',confidence:.41,margin:.21,contextSimilarity:.71}))
 const a=input('小明？'),b=input('接着刚才的话',{userId:'33445678'},'b');gate.observe('c',a);gate.observe('c',b)
 await gate.shouldReply('c',a,companion,signal());assert.equal(await gate.shouldReply('c',b,companion,signal()),false,'admission is not delivery')
 gate.replied('c',a,'已经参与话题');assert.equal(await gate.shouldReply('c',b,companion,signal()),true)
 assert.equal(await gate.shouldReply('other',b,companion,signal()),false)
 assert.equal(await gate.shouldReply('c',{...b,qqGroup:{...b.qqGroup,groupId:'87654321'}},companion,signal()),false)
 assert.equal(await gate.shouldReply('c',{...b,receivedAt:now-1},companion,signal()),false,'queued input cannot inherit a later send')
 now+=179999;assert.equal(await gate.shouldReply('c',b,companion,signal()),true)
 now+=1;assert.equal(await gate.shouldReply('c',b,companion,signal()),false,'silent admissions did not extend the group window')
 assert.match(gate.guidance('c',b),/尚无近期参与依据/)
})
test('shared participation never overrides other-person targets, stops, strong negatives or unrelated weak scores',()=>{
 const c={...context,groupRecent:{at:context.now-1000,text:'聊显卡'},semantic:{label:'engage',confidence:.41,margin:.21,contextSimilarity:.71}}
 for(const e of [input('不用回复'),input('好的'),input('晚安'),input('显卡',{otherMention:true}),input('显卡',{replyTo:'other'})])assert.equal(scoreGroupReply(e,c).reply,false)
 for(const label of ['other','background','close'])assert.equal(scoreGroupReply(input('普通消息'),{...c,semantic:{label,confidence:.9,margin:.6,contextSimilarity:.9}}).reply,false)
 assert.equal(scoreGroupReply(input('不相关的新话题'),{...c,semantic:{...c.semantic,contextSimilarity:.1}}).reply,false)
})
